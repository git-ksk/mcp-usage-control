import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryUsageStore,
  VectorUsageControl,
  type VectorUsagePolicy,
} from './index.js';

const COST_DIMENSION = 'provider_cost_microunits';
const COUNT_DIMENSION = 'operations';

type PolicyOptions = {
  countLimit?: number;
  costLimit?: number;
  reservedCost?: number;
  reservationTtlMs?: number;
};

function request(operationId: string, principalId = 'member-a') {
  return {
    operationId,
    principal: { id: principalId, tenantId: 'tenant-a', plan: 'plus' },
    tool: 'receipt_inference',
    args: {},
  };
}

function costPolicy(
  accountingScopeId: string,
  options: PolicyOptions = {},
): VectorUsagePolicy {
  const countLimit = options.countLimit ?? 10;
  const costLimit = options.costLimit ?? 10_000;
  const reservedCost = options.reservedCost ?? 1_000;
  const reservationTtlMs = options.reservationTtlMs ?? 60_000;

  return {
    quote() {
      return {
        decision: 'allow',
        reservationTtlMs,
        dimensions: [
          {
            key: COUNT_DIMENSION,
            units: 1,
            budgets: [
              { key: `count:scope:${accountingScopeId}`, limit: countLimit },
            ],
          },
          {
            key: COST_DIMENSION,
            units: reservedCost,
            budgets: [
              { key: `cost:scope:${accountingScopeId}`, limit: costLimit },
            ],
          },
        ],
      };
    },
  };
}

function retryGrowth(
  accountingScopeId: string,
  incrementId: string,
  additionalCost: number,
  countLimit: number,
  costLimit: number,
) {
  return {
    incrementId,
    dimensions: [
      {
        key: COUNT_DIMENSION,
        additionalUnits: 0,
        budgets: [
          { key: `count:scope:${accountingScopeId}`, limit: countLimit },
        ],
      },
      {
        key: COST_DIMENSION,
        additionalUnits: additionalCost,
        budgets: [
          { key: `cost:scope:${accountingScopeId}`, limit: costLimit },
        ],
      },
    ],
  } as const;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cost-bearing operation lifecycle', () => {
  it('atomically shares one application-selected accounting scope across callers', async () => {
    const scope = 'board-owner-42';
    const control = new VectorUsageControl(
      new MemoryUsageStore(),
      costPolicy(scope, { countLimit: 1, costLimit: 2_000, reservedCost: 1_000 }),
    );

    const results = await Promise.all([
      control.reserve(request('member-a-operation', 'member-a')),
      control.reserve(request('member-b-operation', 'member-b')),
    ]);

    expect(results.filter(result => result.allowed)).toHaveLength(1);
    const denied = results.find(result => !result.allowed);
    expect(denied).toMatchObject({
      allowed: false,
      reason: 'quota_exceeded',
      limitingDimensionKey: COUNT_DIMENSION,
      limitingBudgetKey: `count:scope:${scope}`,
      remaining: 0,
    });
  });

  it('reserves bounded maximum exposure before dispatch and releases unused cost', async () => {
    const scope = 'workspace-cost-bound';
    const control = new VectorUsageControl(
      new MemoryUsageStore(),
      costPolicy(scope, { countLimit: 10, costLimit: 5_000, reservedCost: 1_000 }),
    );
    const admission = await control.reserve(request('bounded-max'));
    if (!admission.allowed) throw new Error('expected cost-bearing admission');

    expect(admission.lease.reservedByDimension).toEqual([
      { key: COUNT_DIMENSION, reservedUnits: 1 },
      { key: COST_DIMENSION, reservedUnits: 1_000 },
    ]);

    await admission.lease.markLiable();
    let providerDispatches = 0;
    providerDispatches += 1;

    await expect(
      admission.lease.settle(
        [
          { key: COUNT_DIMENSION, actualUnits: 1 },
          { key: COST_DIMENSION, actualUnits: 1_001 },
        ],
        'completed',
      ),
    ).rejects.toThrow('actualUnits cannot exceed reservedUnits');

    const settlement = await admission.lease.settle(
      [
        { key: COUNT_DIMENSION, actualUnits: 1 },
        { key: COST_DIMENSION, actualUnits: 650 },
      ],
      'completed',
    );

    expect(providerDispatches).toBe(1);
    expect(settlement.dimensions).toEqual([
      { key: COUNT_DIMENSION, reservedUnits: 1, actualUnits: 1, releasedUnits: 0 },
      { key: COST_DIMENSION, reservedUnits: 1_000, actualUnits: 650, releasedUnits: 350 },
    ]);
  });

  it('releases a reservation only when no billable effect is proven before dispatch', async () => {
    const scope = 'pre-dispatch-no-effect';
    const store = new MemoryUsageStore();
    const control = new VectorUsageControl(
      store,
      costPolicy(scope, { countLimit: 1, costLimit: 1_000, reservedCost: 1_000 }),
    );

    const first = await control.reserve(request('pre-dispatch-rejected'));
    if (!first.allowed) throw new Error('expected initial admission');
    await first.lease.settle(
      [
        { key: COUNT_DIMENSION, actualUnits: 0 },
        { key: COST_DIMENSION, actualUnits: 0 },
      ],
      'proven_no_effect',
    );

    const replacement = await control.reserve(request('replacement', 'member-b'));
    expect(replacement.allowed).toBe(true);
  });

  it('requires growth before a retry that creates additional billable exposure', async () => {
    const scope = 'retry-cost';
    const countLimit = 10;
    const costLimit = 2_500;
    const control = new VectorUsageControl(
      new MemoryUsageStore(),
      costPolicy(scope, { countLimit, costLimit, reservedCost: 1_000 }),
    );
    const admission = await control.reserve(request('retry-operation'));
    if (!admission.allowed) throw new Error('expected retry admission');

    await admission.lease.markLiable();
    let providerDispatches = 1;

    const growth = await admission.lease.grow(
      retryGrowth(scope, 'provider-attempt-2', 1_000, countLimit, costLimit),
    );
    expect(growth).toMatchObject({
      accepted: true,
      replayed: false,
      reservedByDimension: [
        { key: COUNT_DIMENSION, reservedUnits: 1 },
        { key: COST_DIMENSION, reservedUnits: 2_000 },
      ],
    });

    if (growth.accepted) providerDispatches += 1;
    expect(providerDispatches).toBe(2);

    const settlement = await admission.lease.settle(
      [
        { key: COUNT_DIMENSION, actualUnits: 1 },
        { key: COST_DIMENSION, actualUnits: 1_600 },
      ],
      'completed',
    );
    expect(settlement.dimensions[1]).toEqual({
      key: COST_DIMENSION,
      reservedUnits: 2_000,
      actualUnits: 1_600,
      releasedUnits: 400,
    });
  });

  it('blocks a billable retry when additional exposure cannot be reserved', async () => {
    const scope = 'retry-denied';
    const countLimit = 10;
    const costLimit = 1_500;
    const control = new VectorUsageControl(
      new MemoryUsageStore(),
      costPolicy(scope, { countLimit, costLimit, reservedCost: 1_000 }),
    );
    const admission = await control.reserve(request('retry-denied-operation'));
    if (!admission.allowed) throw new Error('expected initial admission');

    await admission.lease.markLiable();
    let providerDispatches = 1;
    const growth = await admission.lease.grow(
      retryGrowth(scope, 'blocked-provider-attempt', 1_000, countLimit, costLimit),
    );
    expect(growth).toMatchObject({
      accepted: false,
      reason: 'quota_exceeded',
      limitingDimensionKey: COST_DIMENSION,
      limitingBudgetKey: `cost:scope:${scope}`,
      remaining: 500,
    });

    if (growth.accepted) providerDispatches += 1;
    expect(providerDispatches).toBe(1);

    await admission.lease.settle(
      [
        { key: COUNT_DIMENSION, actualUnits: 1 },
        { key: COST_DIMENSION, actualUnits: 1_000 },
      ],
      'dispatched_conservative',
    );
  });

  it('retains liable exposure when post-dispatch usage is ambiguous', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-29T00:00:00Z'));

    const scope = 'ambiguous-provider-timeout';
    const control = new VectorUsageControl(
      new MemoryUsageStore({ idempotencyTtlMs: 1_000 }),
      costPolicy(scope, {
        countLimit: 1,
        costLimit: 1_000,
        reservedCost: 1_000,
        reservationTtlMs: 20,
      }),
    );

    const admission = await control.reserve(request('provider-timeout'));
    if (!admission.allowed) throw new Error('expected timeout admission');
    await admission.lease.markLiable();

    await vi.advanceTimersByTimeAsync(21);
    const later = await control.reserve(request('after-ambiguous-timeout', 'member-b'));
    expect(later).toMatchObject({
      allowed: false,
      reason: 'quota_exceeded',
    });
  });

  it('keeps duplicate logical retries from reserving the same operation twice', async () => {
    const scope = 'idempotent-operation';
    const control = new VectorUsageControl(
      new MemoryUsageStore(),
      costPolicy(scope, { countLimit: 10, costLimit: 10_000, reservedCost: 1_000 }),
    );

    expect((await control.reserve(request('stable-operation-id'))).allowed).toBe(true);
    expect(await control.reserve(request('stable-operation-id'))).toEqual({
      allowed: false,
      reason: 'duplicate_operation',
    });
  });
});
