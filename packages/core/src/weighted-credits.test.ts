import { describe, expect, it } from 'vitest';
import {
  MemoryUsageStore,
  UsageControl,
  createWeightedCreditsPolicy,
  defineWeightedCreditPolicyConfig,
  type UsageRequest,
} from './index.js';

const baseConfig = {
  tools: { search: 1, summarize: 3, ai_analyze: 5, browser_action: 10 },
  plans: {
    free: { limits: { monthly: 50 } },
    plus: { limits: { monthly: 100 } },
  },
  unknownTool: 'deny' as const,
};

function request(tool: string, plan = 'free'): UsageRequest {
  return { operationId: `op:${tool}:${plan}`, principal: { id: 'u1', plan }, tool, args: {} };
}

describe('weighted credit policy', () => {
  it('quotes configured tool units and selected plan limits', async () => {
    const policy = createWeightedCreditsPolicy({
      config: baseConfig,
      budgets: ({ request: req, limit }) => ({ key: `month:user:${req.principal.id}:2026-08`, limit: limit('monthly') }),
    });

    await expect(policy.quote(request('summarize', 'plus'))).resolves.toEqual({
      decision: 'allow',
      units: 3,
      budgets: [{ key: 'month:user:u1:2026-08', limit: 100 }],
    });
  });

  it('denies unknown tools without invoking the budget resolver', async () => {
    let called = false;
    const policy = createWeightedCreditsPolicy({
      config: baseConfig,
      budgets: () => {
        called = true;
        return { key: 'unused', limit: 1 };
      },
    });

    await expect(policy.quote(request('not_configured'))).resolves.toEqual({
      decision: 'deny',
      reason: 'unknown_tool',
    });
    expect(called).toBe(false);
  });

  it('supports an explicit unknown-tool fallback', async () => {
    const policy = createWeightedCreditsPolicy({
      config: { ...baseConfig, unknownTool: { fallbackUnits: 7 } },
      budgets: ({ limit }) => ({ key: 'shared', limit: limit('monthly') }),
    });

    await expect(policy.quote(request('future_tool'))).resolves.toMatchObject({
      decision: 'allow',
      units: 7,
    });
  });

  it('denies missing or unknown plans closed', async () => {
    const policy = createWeightedCreditsPolicy({
      config: baseConfig,
      budgets: ({ limit }) => ({ key: 'shared', limit: limit('monthly') }),
    });

    await expect(policy.quote(request('search', 'enterprise'))).resolves.toEqual({
      decision: 'deny',
      reason: 'unknown_plan',
    });
    await expect(policy.quote({ ...request('search'), principal: { id: 'u1' } })).resolves.toEqual({
      decision: 'deny',
      reason: 'unknown_plan',
    });
  });

  it('allows a trusted async plan resolver', async () => {
    const policy = createWeightedCreditsPolicy({
      config: baseConfig,
      resolvePlan: async () => 'plus',
      budgets: ({ plan, limit }) => ({ key: plan, limit: limit('monthly') }),
    });

    await expect(policy.quote({ ...request('search'), principal: { id: 'u1' } })).resolves.toMatchObject({
      decision: 'allow',
      budgets: [{ key: 'plus', limit: 100 }],
    });
  });

  it('keeps the same budget key across a plan change and preserves consumed usage', async () => {
    const store = new MemoryUsageStore();
    const policy = createWeightedCreditsPolicy({
      config: {
        tools: { analyze: 30 },
        plans: { free: { limits: { monthly: 50 } }, plus: { limits: { monthly: 100 } } },
        unknownTool: 'deny',
      },
      budgets: ({ request: req, limit }) => ({ key: `month:user:${req.principal.id}:2026-08`, limit: limit('monthly') }),
    });
    const control = new UsageControl(store, policy);

    const first = await control.reserve(request('analyze', 'free'));
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error('expected first admission');
    await first.lease.markLiable();
    await first.lease.settle(30, 'completed');

    const upgraded = await control.reserve({ ...request('analyze', 'plus'), operationId: 'op:upgraded' });
    expect(upgraded.allowed).toBe(true);
    if (!upgraded.allowed) throw new Error('expected upgraded admission');
    expect(upgraded.remainingByBudget).toEqual([{ key: 'month:user:u1:2026-08', remaining: 40 }]);
  });

  it('snapshots configuration so later caller mutation cannot change pricing', async () => {
    const mutable = {
      tools: { search: 1 },
      plans: { free: { limits: { monthly: 50 } } },
      unknownTool: 'deny' as const,
    };
    const policy = createWeightedCreditsPolicy({
      config: mutable,
      budgets: ({ limit }) => ({ key: 'shared', limit: limit('monthly') }),
    });
    mutable.tools.search = 99;
    mutable.plans.free.limits.monthly = 999;

    await expect(policy.quote(request('search'))).resolves.toMatchObject({
      units: 1,
      budgets: [{ key: 'shared', limit: 50 }],
    });
  });

  it('validates units, limits, unknown fields, fallback units, and ttl eagerly', () => {
    expect(() => defineWeightedCreditPolicyConfig({ ...baseConfig, tools: { search: -1 } })).toThrow(RangeError);
    expect(() => defineWeightedCreditPolicyConfig({ ...baseConfig, plans: { free: { limits: { monthly: 1.5 } } } })).toThrow(RangeError);
    expect(() => defineWeightedCreditPolicyConfig({ ...baseConfig, unknownTool: { fallbackUnits: -1 } })).toThrow(RangeError);
    expect(() => defineWeightedCreditPolicyConfig({ ...baseConfig, extra: true } as never)).toThrow(/unknown field/);
    expect(() => createWeightedCreditsPolicy({ config: baseConfig, budgets: () => ({ key: 'x', limit: 1 }), reservationTtlMs: 0 })).toThrow(RangeError);
  });

  it('supports multiple caller-owned budgets without changing Store semantics', async () => {
    const policy = createWeightedCreditsPolicy({
      config: {
        tools: { search: 2 },
        plans: { free: { limits: { user: 50, tenant: 500 } } },
        unknownTool: 'deny',
      },
      budgets: ({ request: req, limit }) => [
        { key: `user:${req.principal.id}`, limit: limit('user') },
        { key: `tenant:${req.principal.tenantId}`, limit: limit('tenant') },
      ],
      reservationTtlMs: 5_000,
    });

    await expect(policy.quote({ ...request('search'), principal: { id: 'u1', tenantId: 't1', plan: 'free' } })).resolves.toEqual({
      decision: 'allow',
      units: 2,
      budgets: [
        { key: 'user:u1', limit: 50 },
        { key: 'tenant:t1', limit: 500 },
      ],
      reservationTtlMs: 5_000,
    });
  });
});
