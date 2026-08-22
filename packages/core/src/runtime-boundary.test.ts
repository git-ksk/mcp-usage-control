import { describe, expect, it } from 'vitest';
import {
  MemoryUsageStore,
  UsageControl,
  VectorUsageControl,
  type ProgressiveUsageStore,
  type UsagePolicy,
  type UsageRequest,
  type UsageStore,
  type VectorUsagePolicy,
  type VectorUsageStore,
} from './index.js';

function request(operationId = 'op-1'): UsageRequest {
  return {
    operationId,
    principal: { id: 'user-1', tenantId: 'tenant-1', plan: 'free' },
    tool: 'search',
    args: {},
  };
}

const scalarBudget = { key: 'daily:user-1', limit: 10 } as const;
const vectorDimensions = [
  { key: 'requests', units: 1, budgets: [{ key: 'requests:user-1', limit: 10 }] },
  { key: 'tokens', units: 2, budgets: [{ key: 'tokens:user-1', limit: 20 }] },
] as const;

function unsafeScalarPolicy(value: unknown): UsagePolicy {
  return { quote: () => value } as unknown as UsagePolicy;
}

function unsafeVectorPolicy(value: unknown): VectorUsagePolicy {
  return { quote: () => value } as unknown as VectorUsagePolicy;
}

function unusedStoreMethods() {
  return {
    async markLiable() {
      throw new Error('unused');
    },
    async renew() {
      throw new Error('unused');
    },
    async settle() {
      throw new Error('unused');
    },
  };
}

describe('runtime policy quote validation', () => {
  it.each([
    ['unknown decision', { decision: 'denied', units: 1, budgets: [scalarBudget] }],
    ['missing decision', { units: 1, budgets: [scalarBudget] }],
    ['empty deny reason', { decision: 'deny', reason: '' }],
    ['non-string deny reason', { decision: 'deny', reason: 1 }],
    ['oversized deny reason', { decision: 'deny', reason: 'x'.repeat(129) }],
    ['missing budget shape', { decision: 'allow', units: 1 }],
    [
      'ambiguous budget shape',
      { decision: 'allow', units: 1, budget: scalarBudget, budgets: [scalarBudget] },
    ],
    ['non-array budgets', { decision: 'allow', units: 1, budgets: scalarBudget }],
    ['malformed units', { decision: 'allow', units: '1', budgets: [scalarBudget] }],
  ])('scalar policy rejects %s before accounting mutation', async (_name, quote) => {
    const store = new MemoryUsageStore();
    const control = new UsageControl(store, unsafeScalarPolicy(quote));

    await expect(control.reserve(request())).rejects.toBeInstanceOf(Error);
    expect(store.stats()).toMatchObject({ retainedOperations: 0, retainedBudgetKeys: 0 });
  });

  it.each([
    ['unknown decision', { decision: 'denied', dimensions: vectorDimensions }],
    ['missing decision', { dimensions: vectorDimensions }],
    ['empty deny reason', { decision: 'deny', reason: '' }],
    ['non-array dimensions', { decision: 'allow', dimensions: {} }],
    ['empty dimensions', { decision: 'allow', dimensions: [] }],
    [
      'malformed dimension',
      { decision: 'allow', dimensions: [null] },
    ],
  ])('vector policy rejects %s before accounting mutation', async (_name, quote) => {
    const store = new MemoryUsageStore();
    const control = new VectorUsageControl(store, unsafeVectorPolicy(quote));

    await expect(control.reserve(request())).rejects.toBeInstanceOf(Error);
    expect(store.stats()).toMatchObject({ retainedOperations: 0, retainedBudgetKeys: 0 });
  });
});

describe('runtime Store result validation', () => {
  it('does not treat a truthy non-boolean scalar accepted result as admission', async () => {
    const store: UsageStore = {
      async reserve() {
        return { accepted: 'true' } as never;
      },
      ...unusedStoreMethods(),
    };
    const control = new UsageControl(
      store,
      unsafeScalarPolicy({ decision: 'allow', units: 1, budgets: [scalarBudget] }),
    );

    await expect(control.reserve(request())).rejects.toThrow(/accepted must be a boolean/);
  });

  it('does not treat a truthy non-boolean vector accepted result as admission', async () => {
    const store: VectorUsageStore = {
      async reserve() {
        throw new Error('unused');
      },
      async reserveVector() {
        return { accepted: {} } as never;
      },
      async growVectorReservation() {
        throw new Error('unused');
      },
      async settleVector() {
        throw new Error('unused');
      },
      ...unusedStoreMethods(),
    };
    const control = new VectorUsageControl(
      store,
      unsafeVectorPolicy({ decision: 'allow', dimensions: vectorDimensions }),
    );

    await expect(control.reserve(request())).rejects.toThrow(/accepted must be a boolean/);
  });

  it('rejects an accepted scalar reservation whose identity does not match the request', async () => {
    const store: UsageStore = {
      async reserve(input) {
        return {
          accepted: true,
          reservation: {
            id: 'reservation-1',
            operationId: 'different-operation',
            principalId: input.request.principal.id,
            ...(input.request.principal.tenantId === undefined
              ? {}
              : { tenantId: input.request.principal.tenantId }),
            ...(input.request.principal.plan === undefined
              ? {}
              : { plan: input.request.principal.plan }),
            tool: input.request.tool,
            budgetKeys: input.budgets.map(budget => budget.key),
            reservedUnits: input.units,
            expiresAt: Date.now() + input.ttlMs,
          },
          remainingByBudget: input.budgets.map(budget => ({ key: budget.key, remaining: 9 })),
        };
      },
      ...unusedStoreMethods(),
    };
    const control = new UsageControl(
      store,
      unsafeScalarPolicy({ decision: 'allow', units: 1, budgets: [scalarBudget] }),
    );

    await expect(control.reserve(request())).rejects.toThrow(/identity did not match/);
  });

  it('rejects an accepted vector reservation whose budget topology does not match the request', async () => {
    const store: VectorUsageStore = {
      async reserve() {
        throw new Error('unused');
      },
      async reserveVector(input) {
        return {
          accepted: true,
          reservation: {
            id: 'vector-reservation-1',
            operationId: input.request.operationId,
            principalId: input.request.principal.id,
            ...(input.request.principal.tenantId === undefined
              ? {}
              : { tenantId: input.request.principal.tenantId }),
            ...(input.request.principal.plan === undefined
              ? {}
              : { plan: input.request.principal.plan }),
            tool: input.request.tool,
            dimensions: input.dimensions.map((dimension, index) => ({
              key: dimension.key,
              budgetKeys: index === 0 ? ['wrong-budget'] : dimension.budgets.map(budget => budget.key),
              reservedUnits: dimension.units,
            })),
            expiresAt: Date.now() + input.ttlMs,
          },
          remainingByBudget: input.dimensions.flatMap(dimension =>
            dimension.budgets.map(budget => ({
              dimensionKey: dimension.key,
              budgetKey: budget.key,
              remaining: budget.limit - dimension.units,
            })),
          ),
        };
      },
      async growVectorReservation() {
        throw new Error('unused');
      },
      async settleVector() {
        throw new Error('unused');
      },
      ...unusedStoreMethods(),
    };
    const control = new VectorUsageControl(
      store,
      unsafeVectorPolicy({ decision: 'allow', dimensions: vectorDimensions }),
    );

    await expect(control.reserve(request())).rejects.toThrow(/budgetKeys did not match/);
  });

  it('keeps scalar growth pinned when a Store returns a malformed accepted discriminant', async () => {
    const inner = new MemoryUsageStore();
    let growthCalls = 0;
    const store: ProgressiveUsageStore = {
      reserve: input => inner.reserve(input),
      markLiable: input => inner.markLiable(input),
      renew: input => inner.renew(input),
      settle: input => inner.settle(input),
      async growReservation() {
        growthCalls += 1;
        return { accepted: 'true' } as never;
      },
    };
    const control = new UsageControl(
      store,
      unsafeScalarPolicy({ decision: 'allow', units: 1, budgets: [scalarBudget] }),
    );
    const admission = await control.reserve(request());
    if (!admission.allowed) throw new Error('expected admission');

    const first = {
      incrementId: 'increment-a',
      additionalUnits: 1,
      budgets: [scalarBudget],
    } as const;
    await expect(admission.lease.grow(first)).rejects.toThrow(/accepted must be a boolean/);
    await expect(
      admission.lease.grow({ ...first, incrementId: 'increment-b' }),
    ).rejects.toThrow(/unresolved/);
    expect(growthCalls).toBe(1);
    await expect(admission.lease.grow(first)).rejects.toThrow(/accepted must be a boolean/);
    expect(growthCalls).toBe(2);
  });
});

describe('runtime request identity validation', () => {
  it.each([
    ['operationId', { ...request(), operationId: 123 }],
    ['principal.id', { ...request(), principal: { ...request().principal, id: 123 } }],
    ['tool', { ...request(), tool: { name: 'search' } }],
    ['tenantId', { ...request(), principal: { ...request().principal, tenantId: 7 } }],
    ['plan', { ...request(), principal: { ...request().principal, plan: true } }],
  ])('rejects malformed %s before Memory accounting mutation', async (_name, malformed) => {
    const store = new MemoryUsageStore();
    await expect(
      store.reserve({
        request: malformed as unknown as UsageRequest,
        units: 1,
        budgets: [scalarBudget],
        ttlMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(store.stats()).toMatchObject({ retainedOperations: 0, retainedBudgetKeys: 0 });
  });

  it('preserves delimiter-containing and Unicode request identity strings', async () => {
    const store = new MemoryUsageStore();
    const valid: UsageRequest = {
      operationId: 'op|日本語:1',
      principal: { id: 'user:雪|1', tenantId: 'tenant/東京', plan: 'plus✨' },
      tool: 'tool/検索|v1',
      args: {},
    };
    await expect(
      store.reserve({ request: valid, units: 1, budgets: [scalarBudget], ttlMs: 1_000 }),
    ).resolves.toMatchObject({ accepted: true });
  });
});
