import type { UsageEvent, UsageObserverHandler } from './observability.js';
import type { SettlementOutcomeDiagnosticSink } from './settlement-outcomes.js';

export const MCP_USAGE_CONTROL_PACKAGE_NAME = 'mcp-usage-control';
export const MCP_USAGE_CONTROL_VERSION = '1.0.0';

export type UsageRuntimeProvider = 'memory' | 'redis' | 'firestore' | 'cloudflare' | 'custom';
export type UsageRuntimeCapability =
  | 'progressive'
  | 'vector'
  | 'reconciliation'
  | 'mcp_multi_round';

export interface UsageRuntimeIdentity {
  packageName: string;
  packageVersion: string;
  provider: UsageRuntimeProvider;
  capabilities: readonly UsageRuntimeCapability[];
  storageSchemaVersion?: string;
}

export interface UsageRuntimeIdentityInput {
  provider: UsageRuntimeProvider;
  capabilities?: readonly UsageRuntimeCapability[];
  packageName?: string;
  packageVersion?: string;
  storageSchemaVersion?: string;
}

export interface UsageOperationalErrorCounters {
  quote: number;
  reserve: number;
  markLiable: number;
  renew: number;
  settle: number;
}

export interface UsageOperationalObservedAttempts {
  reserve: number;
  settle: number;
}

export interface UsageOperationalLifecycleCounters {
  eventsObserved: number;
  reserveAccepted: number;
  reserveDenied: number;
  settlementsCompleted: number;
  pendingReservationsReleased: number;
  liableReservationsRetained: number;
  invalidSettlementOutcomes: number;
  observedAttempts: UsageOperationalObservedAttempts;
  errors: UsageOperationalErrorCounters;
}

export interface UsageOperationalSnapshot {
  identity?: UsageRuntimeIdentity;
  lifecycle: UsageOperationalLifecycleCounters;
  lastEventAt?: number;
}

export interface ScopedQuotaSnapshot {
  limit: number;
  remaining: number;
  used: number;
  exhausted: boolean;
  utilization: number;
}

export interface ScopedQuotaWindowSnapshot extends ScopedQuotaSnapshot {
  /** Exclusive epoch-millisecond end of the known accounting window. */
  resetsAt: number;
}

/**
 * Build a bounded, static runtime descriptor suitable for health output.
 * Identity is diagnostic only and must never participate in admission decisions.
 */
export function createUsageRuntimeIdentity(input: UsageRuntimeIdentityInput): UsageRuntimeIdentity {
  const packageName = input.packageName ?? MCP_USAGE_CONTROL_PACKAGE_NAME;
  const packageVersion = input.packageVersion ?? MCP_USAGE_CONTROL_VERSION;
  validateStaticIdentifier(packageName, 'packageName', 128);
  validateStaticIdentifier(packageVersion, 'packageVersion', 64);
  validateProvider(input.provider);
  if (input.storageSchemaVersion !== undefined) {
    validateStaticIdentifier(input.storageSchemaVersion, 'storageSchemaVersion', 64);
  }
  const capabilities = [...new Set(input.capabilities ?? [])];
  for (const capability of capabilities) validateCapability(capability);
  capabilities.sort();
  return {
    packageName,
    packageVersion,
    provider: input.provider,
    capabilities,
    ...(input.storageSchemaVersion === undefined
      ? {}
      : { storageSchemaVersion: input.storageSchemaVersion }),
  };
}

/**
 * Project one explicitly selected authoritative budget balance into a safe quota view.
 * Callers own the budget/window identity and must select the correct scoped balance.
 */
export function projectScopedQuota(limit: number, remaining: number): ScopedQuotaSnapshot {
  assertNonNegativeSafeInteger(limit, 'limit');
  assertNonNegativeSafeInteger(remaining, 'remaining');
  if (remaining > limit) throw new RangeError('remaining cannot exceed limit');
  return {
    limit,
    remaining,
    used: limit - remaining,
    exhausted: remaining === 0,
    utilization: limit === 0 ? 1 : (limit - remaining) / limit,
  };
}

/**
 * Add a caller-selected known reset boundary to one scoped quota projection.
 * The boundary is policy/UX metadata only and is never inferred from a budget key.
 */
export function projectScopedQuotaWindow(
  limit: number,
  remaining: number,
  resetsAt: number,
): ScopedQuotaWindowSnapshot {
  assertNonNegativeSafeInteger(resetsAt, 'resetsAt');
  return { ...projectScopedQuota(limit, remaining), resetsAt };
}

/**
 * Process-local bounded lifecycle counters derived from UsageEvent.
 * This observer is deliberately non-authoritative and never infers quota truth.
 */
export class UsageOperationalMonitor
  implements UsageObserverHandler, SettlementOutcomeDiagnosticSink
{
  private readonly identity: UsageRuntimeIdentity | undefined;
  private counters: UsageOperationalLifecycleCounters = emptyCounters();
  private lastEventAt: number | undefined;

  constructor(identity?: UsageRuntimeIdentity) {
    this.identity = identity === undefined ? undefined : createUsageRuntimeIdentity(identity);
  }

  onInvalidSettlementOutcome(): void {
    this.counters.invalidSettlementOutcomes = increment(this.counters.invalidSettlementOutcomes);
  }

  onEvent(event: UsageEvent): void {
    this.counters.eventsObserved = increment(this.counters.eventsObserved);
    this.lastEventAt = event.timestamp;

    switch (event.type) {
      case 'reserve.accepted':
      case 'vector.reserve.accepted':
        this.counters.reserveAccepted = increment(this.counters.reserveAccepted);
        this.counters.observedAttempts.reserve = increment(this.counters.observedAttempts.reserve);
        return;
      case 'reserve.denied':
      case 'vector.reserve.denied':
        this.counters.reserveDenied = increment(this.counters.reserveDenied);
        this.counters.observedAttempts.reserve = increment(this.counters.observedAttempts.reserve);
        return;
      case 'settlement.completed':
      case 'vector.settlement.completed':
        this.counters.settlementsCompleted = increment(this.counters.settlementsCompleted);
        this.counters.observedAttempts.settle = increment(this.counters.observedAttempts.settle);
        return;
      case 'reservation.recovered':
      case 'vector.reservation.recovered':
        if (event.recovery === 'pending_released') {
          this.counters.pendingReservationsReleased = add(this.counters.pendingReservationsReleased, event.count);
        } else {
          this.counters.liableReservationsRetained = add(this.counters.liableReservationsRetained, event.count);
        }
        return;
      case 'operation.error': {
        const key = errorCounterKey(event.phase);
        this.counters.errors[key] = increment(this.counters.errors[key]);
        if (event.phase === 'reserve') {
          this.counters.observedAttempts.reserve = increment(this.counters.observedAttempts.reserve);
        } else if (event.phase === 'settle') {
          this.counters.observedAttempts.settle = increment(this.counters.observedAttempts.settle);
        }
        return;
      }
    }
  }

  snapshot(): UsageOperationalSnapshot {
    return {
      ...(this.identity === undefined ? {} : { identity: cloneIdentity(this.identity) }),
      lifecycle: {
        ...this.counters,
        observedAttempts: { ...this.counters.observedAttempts },
        errors: { ...this.counters.errors },
      },
      ...(this.lastEventAt === undefined ? {} : { lastEventAt: this.lastEventAt }),
    };
  }
}

function emptyCounters(): UsageOperationalLifecycleCounters {
  return {
    eventsObserved: 0,
    reserveAccepted: 0,
    reserveDenied: 0,
    settlementsCompleted: 0,
    pendingReservationsReleased: 0,
    liableReservationsRetained: 0,
    invalidSettlementOutcomes: 0,
    observedAttempts: {
      reserve: 0,
      settle: 0,
    },
    errors: {
      quote: 0,
      reserve: 0,
      markLiable: 0,
      renew: 0,
      settle: 0,
    },
  };
}

function errorCounterKey(
  phase: 'quote' | 'reserve' | 'mark_liable' | 'renew' | 'settle',
): keyof UsageOperationalErrorCounters {
  return phase === 'mark_liable' ? 'markLiable' : phase;
}

function increment(value: number): number {
  return add(value, 1);
}

function add(value: number, amount: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0) return Number.MAX_SAFE_INTEGER;
  if (value >= Number.MAX_SAFE_INTEGER - amount) return Number.MAX_SAFE_INTEGER;
  return value + amount;
}

function cloneIdentity(identity: UsageRuntimeIdentity): UsageRuntimeIdentity {
  return {
    ...identity,
    capabilities: [...identity.capabilities],
  };
}

function validateProvider(value: string): asserts value is UsageRuntimeProvider {
  if (
    value !== 'memory' &&
    value !== 'redis' &&
    value !== 'firestore' &&
    value !== 'cloudflare' &&
    value !== 'custom'
  ) {
    throw new TypeError('Unsupported usage runtime provider');
  }
}

function validateCapability(value: string): asserts value is UsageRuntimeCapability {
  if (
    value !== 'progressive' &&
    value !== 'vector' &&
    value !== 'reconciliation' &&
    value !== 'mcp_multi_round'
  ) {
    throw new TypeError('Unsupported usage runtime capability');
  }
}

function validateStaticIdentifier(value: string, name: string, maxLength: number): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !/^[A-Za-z0-9@/._+-]+$/.test(value)
  ) {
    throw new TypeError(`${name} must be a bounded static identifier`);
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}
