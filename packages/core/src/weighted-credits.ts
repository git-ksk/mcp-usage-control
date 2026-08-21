import type { Budget, UsagePolicy, UsageRequest } from './index.js';

export type UnknownWeightedCreditTool = 'deny' | Readonly<{ fallbackUnits: number }>;

export type WeightedCreditPlanConfig = Readonly<{
  limits: Readonly<Record<string, number>>;
}>;

export type WeightedCreditPolicyConfig = Readonly<{
  tools: Readonly<Record<string, number>>;
  plans: Readonly<Record<string, WeightedCreditPlanConfig>>;
  unknownTool: UnknownWeightedCreditTool;
}>;

export type WeightedCreditBudgetContext = Readonly<{
  request: UsageRequest;
  plan: string;
  /** Resolve one configured plan limit by name; unknown names fail closed. */
  limit(name: string): number;
}>;

export type WeightedCreditBudgetResolver = (
  context: WeightedCreditBudgetContext,
) => Budget | readonly Budget[] | Promise<Budget | readonly Budget[]>;

export type WeightedCreditPlanResolver = (
  request: UsageRequest,
) => string | undefined | Promise<string | undefined>;

export type WeightedCreditsPolicyOptions = Readonly<{
  /** Already-loaded trusted configuration. File/network loading remains application-owned. */
  config: WeightedCreditPolicyConfig;
  /** Maps the selected plan limits to one or more application-owned budget identities. */
  budgets: WeightedCreditBudgetResolver;
  /** Defaults to request.principal.plan. Unknown/missing plans deny closed. */
  resolvePlan?: WeightedCreditPlanResolver;
  reservationTtlMs?: number;
}>;

/**
 * Validate and snapshot an already-loaded weighted-credit configuration.
 *
 * This helper intentionally does not parse JSON/YAML, resolve entitlements, derive
 * accounting windows, or persist pricing/subscription state. Because duplicate
 * textual JSON keys are lost before an object reaches this API, duplicate-key
 * rejection (when required) belongs to the application's config loader.
 */
export function defineWeightedCreditPolicyConfig(
  config: WeightedCreditPolicyConfig,
): WeightedCreditPolicyConfig {
  assertPlainRecord(config, 'config');
  assertExactKeys(config, ['tools', 'plans', 'unknownTool'], 'config');

  assertPlainRecord(config.tools, 'config.tools');
  const tools: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [tool, units] of Object.entries(config.tools)) {
    assertNonEmptyKey(tool, 'tool');
    assertNonNegativeSafeInteger(units, `config.tools[${JSON.stringify(tool)}]`);
    tools[tool] = units;
  }

  assertPlainRecord(config.plans, 'config.plans');
  const plans: Record<string, WeightedCreditPlanConfig> = Object.create(null) as Record<
    string,
    WeightedCreditPlanConfig
  >;
  for (const [plan, entry] of Object.entries(config.plans)) {
    assertNonEmptyKey(plan, 'plan');
    assertPlainRecord(entry, `config.plans[${JSON.stringify(plan)}]`);
    assertExactKeys(entry, ['limits'], `config.plans[${JSON.stringify(plan)}]`);
    assertPlainRecord(entry.limits, `config.plans[${JSON.stringify(plan)}].limits`);

    const limits: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [name, limit] of Object.entries(entry.limits)) {
      assertNonEmptyKey(name, 'limit');
      assertNonNegativeSafeInteger(
        limit,
        `config.plans[${JSON.stringify(plan)}].limits[${JSON.stringify(name)}]`,
      );
      limits[name] = limit;
    }
    if (Object.keys(limits).length === 0) {
      throw new RangeError(`config.plans[${JSON.stringify(plan)}].limits must not be empty`);
    }
    plans[plan] = Object.freeze({ limits: Object.freeze(limits) });
  }
  if (Object.keys(plans).length === 0) {
    throw new RangeError('config.plans must not be empty');
  }

  let unknownTool: UnknownWeightedCreditTool;
  if (config.unknownTool === 'deny') {
    unknownTool = 'deny';
  } else {
    assertPlainRecord(config.unknownTool, 'config.unknownTool');
    assertExactKeys(config.unknownTool, ['fallbackUnits'], 'config.unknownTool');
    assertNonNegativeSafeInteger(config.unknownTool.fallbackUnits, 'config.unknownTool.fallbackUnits');
    unknownTool = Object.freeze({ fallbackUnits: config.unknownTool.fallbackUnits });
  }

  return Object.freeze({
    tools: Object.freeze(tools),
    plans: Object.freeze(plans),
    unknownTool,
  });
}

/** Build a deterministic weighted-credit UsagePolicy over application-owned budgets. */
export function createWeightedCreditsPolicy(options: WeightedCreditsPolicyOptions): UsagePolicy {
  assertPlainRecord(options, 'options');
  assertExactKeys(options, ['config', 'budgets', 'resolvePlan', 'reservationTtlMs'], 'options');
  if (typeof options.budgets !== 'function') throw new TypeError('options.budgets must be a function');
  if (options.resolvePlan !== undefined && typeof options.resolvePlan !== 'function') {
    throw new TypeError('options.resolvePlan must be a function when provided');
  }
  if (options.reservationTtlMs !== undefined) {
    assertPositiveSafeInteger(options.reservationTtlMs, 'options.reservationTtlMs');
  }

  const config = defineWeightedCreditPolicyConfig(options.config);
  const budgets = options.budgets;
  const resolvePlan = options.resolvePlan ?? ((request: UsageRequest) => request.principal.plan);
  const reservationTtlMs = options.reservationTtlMs;

  return Object.freeze({
    async quote(request: UsageRequest) {
      const configuredUnits = config.tools[request.tool];
      const units = configuredUnits ??
        (config.unknownTool === 'deny' ? undefined : config.unknownTool.fallbackUnits);
      if (units === undefined) return { decision: 'deny' as const, reason: 'unknown_tool' };

      const plan = await resolvePlan(request);
      if (plan === undefined || config.plans[plan] === undefined) {
        return { decision: 'deny' as const, reason: 'unknown_plan' };
      }

      const planLimits = config.plans[plan].limits;
      const resolved = await budgets({
        request,
        plan,
        limit(name: string) {
          const value = planLimits[name];
          if (value === undefined) {
            throw new RangeError(`unknown configured limit ${JSON.stringify(name)} for plan ${JSON.stringify(plan)}`);
          }
          return value;
        },
      });
      const normalizedBudgets = Array.isArray(resolved) ? resolved : [resolved];

      return {
        decision: 'allow' as const,
        units,
        budgets: normalizedBudgets,
        ...(reservationTtlMs === undefined ? {} : { reservationTtlMs }),
      };
    },
  });
}

function assertPlainRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${name} contains unknown field ${JSON.stringify(key)}`);
  }
  for (const key of allowed) {
    if (!(key in value) && (key === 'config' || key === 'budgets' || key === 'tools' || key === 'plans' || key === 'unknownTool' || key === 'limits')) {
      throw new TypeError(`${name}.${key} is required`);
    }
  }
}

function assertNonEmptyKey(value: string, kind: string): void {
  if (value.trim().length === 0) throw new TypeError(`${kind} key must not be empty`);
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
