import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryUsageStore,
  UsageControl,
  UsageStateError,
  VectorUsageControl,
  type StoreVectorGrowResult,
  type UsagePolicy,
  type VectorGrowReservationInput,
  type VectorUsagePolicy,
  type VectorUsageStore,
} from './index.js';

function request(operationId: string) {
  return {
    operationId,
    principal: { id: 'user-1', tenantId: 'tenant-1', plan: 'free' },
    tool: 'generate',
    args: {},
  };
}

const vectorPolicy: VectorUsagePolicy = {
  quote(req) {
    return {
      decision: 'allow',
      dimensions: [
        {
          key: 'requests',
          units: 1,
          budgets: [
            { key: `request:user:${req.principal.id}`, limit: 10 },
            { key: `request:tenant:${req.principal.tenantId}`, limit: 10 },
          ],
        },
        {
          key: 'tokens',
          units: 5,
          budgets: [
            { key: `tokens:user:${req.principal.id}`, limit: 100 },
            { key: `tokens:tenant:${req.principal.tenantId}`, limit: 100 },
          ],
        },
      ],
    };
  },
};

function growth(incrementId: string, requestUnits: number, tokenUnits: number) {
  return {
    incrementId,
    dimensions: [
      {
        key: 'requests',
        additionalUnits: requestUnits,
        budgets: [
          { key: 'request:user:user-1', limit: 10 },
          { key: 'request:tenant:tenant-1', limit: 10 },
        ],
      },
      {
        key: 'tokens',
        additionalUnits: tokenUnits,
        budgets: [
          { key: 'tokens:user:user-1', limit: 100 },
          { key: 'tokens:tenant:tenant-1', limit: 100 },
        ],
      },
    ],
  } as const;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('atomic vector usage', () => {
  it('reserves different units per dimension and settles each dimension independently', async () => {
    const control = new VectorUsageControl(new MemoryUsageStore(), vectorPolicy);
    const admission = await control.reserve(request('vector-a'));
    if (!admission.allowed) throw new Error('expected vector admission');

    expect(admission.lease.reservedByDimension).toEqual([
      { key: 'requests', reservedUnits: 1 },
      { key: 'tokens', reservedUnits: 5 },
    ]);
    expect(admission.remainingByBudget).toEqual([
      { dimensionKey: 'requests', budgetKey: 'request:tenant:tenant-1', remaining: 9 },
      { dimensionKey: 'requests', budgetKey: 'request:user:user-1', remaining: 9 },
      { dimensionKey: 'tokens', budgetKey: 'tokens:tenant:tenant-1', remaining: 95 },
      { dimensionKey: 'tokens', budgetKey: 'tokens:user:user-1', remaining: 95 },
    ]);

    const settlement = await admission.lease.settle(
      [
        { key: 'requests', actualUnits: 1 },
        { key: 'tokens', actualUnits: 3 },
      ],
      'success',
    );
    expect(settlement.dimensions).toEqual([
      { key: 'requests', reservedUnits: 1, actualUnits: 1, releasedUnits: 0 },
      { key: 'tokens', reservedUnits: 5, actualUnits: 3, releasedUnits: 2 },
    ]);
  });

  it('rolls back the whole vector when one dimension is denied', async () => {
    const store = new MemoryUsageStore();
    const policy: VectorUsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          dimensions: [
            { key: 'requests', units: 1, budgets: [{ key: 'request:shared', limit: 1 }] },
            { key: 'tokens', units: 7, budgets: [{ key: 'tokens:shared', limit: 7 }] },
          ],
        };
      },
    };
    const control = new VectorUsageControl(store, policy);
    expect((await control.reserve(request('first'))).allowed).toBe(true);

    const denied = await control.reserve(request('second'));
    expect(denied).toEqual({
      allowed: false,
      reason: 'quota_exceeded',
      limitingDimensionKey: 'requests',
      limitingBudgetKey: 'request:shared',
      remaining: 0,
    });

    const tokenOnly = new UsageControl(store, {
      quote() {
        return { decision: 'allow', units: 0, budgets: [{ key: 'request:shared', limit: 1 }] };
      },
    });
    const zero = await tokenOnly.reserve(request('probe-zero'));
    expect(zero.allowed).toBe(true);

    const tokenProbe = new UsageControl(store, {
      quote() {
        return { decision: 'allow', units: 0, budgets: [{ key: 'tokens:shared', limit: 7 }] };
      },
    });
    expect((await tokenProbe.reserve(request('probe-token'))).allowed).toBe(true);
  });

  it('shares one operation-idempotency domain with scalar reservations', async () => {
    const store = new MemoryUsageStore();
    const vector = new VectorUsageControl(store, vectorPolicy);
    const scalarPolicy: UsagePolicy = {
      quote() {
        return { decision: 'allow', units: 0, budgets: [{ key: 'scalar', limit: 10 }] };
      },
    };
    const scalar = new UsageControl(store, scalarPolicy);

    expect((await vector.reserve(request('same-operation'))).allowed).toBe(true);
    expect(await scalar.reserve(request('same-operation'))).toEqual({
      allowed: false,
      reason: 'duplicate_operation',
    });
  });

  it('grows multiple dimensions atomically and exact-replays one increment', async () => {
    const control = new VectorUsageControl(new MemoryUsageStore(), vectorPolicy);
    const admission = await control.reserve(request('growth'));
    if (!admission.allowed) throw new Error('expected vector admission');

    const first = await admission.lease.grow(growth('inc-1', 0, 10));
    expect(first).toMatchObject({
      accepted: true,
      replayed: false,
      previousReservedByDimension: [
        { key: 'requests', reservedUnits: 1 },
        { key: 'tokens', reservedUnits: 5 },
      ],
      reservedByDimension: [
        { key: 'requests', reservedUnits: 1 },
        { key: 'tokens', reservedUnits: 15 },
      ],
    });

    const cursorAfterFirst = admission.lease.reservation.growthCursor;
    const store = new MemoryUsageStore();
    const direct = new VectorUsageControl(store, vectorPolicy);
    const directAdmission = await direct.reserve(request('direct-replay'));
    if (!directAdmission.allowed) throw new Error('expected vector admission');
    const oldCursor = directAdmission.lease.reservation.growthCursor!;
    const input: VectorGrowReservationInput = {
      reservationId: directAdmission.lease.reservation.id,
      expectedGrowthCursor: oldCursor,
      ...growth('same-inc', 0, 2),
    };
    const accepted = await store.growVectorReservation(input);
    const replay = await store.growVectorReservation(input);
    expect(accepted.accepted).toBe(true);
    expect(replay).toMatchObject({ accepted: true, replayed: true });
    expect(directAdmission.lease.reservation.growthCursor).toBe(oldCursor);
    expect(cursorAfterFirst).toBeTruthy();
  });

  it('denies one vector growth without partially increasing another dimension', async () => {
    const store = new MemoryUsageStore();
    const policy: VectorUsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          dimensions: [
            { key: 'requests', units: 1, budgets: [{ key: 'req', limit: 2 }] },
            { key: 'tokens', units: 5, budgets: [{ key: 'tok', limit: 5 }] },
          ],
        };
      },
    };
    const control = new VectorUsageControl(store, policy);
    const admission = await control.reserve(request('deny-growth'));
    if (!admission.allowed) throw new Error('expected admission');

    const result = await admission.lease.grow({
      incrementId: 'deny',
      dimensions: [
        { key: 'requests', additionalUnits: 1, budgets: [{ key: 'req', limit: 2 }] },
        { key: 'tokens', additionalUnits: 1, budgets: [{ key: 'tok', limit: 5 }] },
      ],
    });
    expect(result).toMatchObject({
      accepted: false,
      reason: 'quota_exceeded',
      limitingDimensionKey: 'tokens',
      limitingBudgetKey: 'tok',
      remaining: 0,
    });
    expect(admission.lease.reservedByDimension).toEqual([
      { key: 'requests', reservedUnits: 1 },
      { key: 'tokens', reservedUnits: 5 },
    ]);
  });

  it('pins an ambiguous committed vector growth to exact retry after lost ACK', async () => {
    const inner = new MemoryUsageStore();
    let loseAck = true;
    const store: VectorUsageStore = {
      reserve: input => inner.reserve(input),
      markLiable: input => inner.markLiable(input),
      renew: input => inner.renew(input),
      settle: input => inner.settle(input),
      reserveVector: input => inner.reserveVector(input),
      settleVector: input => inner.settleVector(input),
      async growVectorReservation(input): Promise<StoreVectorGrowResult> {
        const committed = await inner.growVectorReservation(input);
        if (loseAck) {
          loseAck = false;
          throw new Error('lost ACK after commit');
        }
        return committed;
      },
    };
    const control = new VectorUsageControl(store, vectorPolicy);
    const admission = await control.reserve(request('lost-ack'));
    if (!admission.allowed) throw new Error('expected admission');

    await expect(admission.lease.grow(growth('inc-lost', 0, 2))).rejects.toThrow(
      'lost ACK after commit',
    );
    await expect(admission.lease.grow(growth('fresh-id', 0, 2))).rejects.toThrow(
      'retry the same incrementId',
    );
    const replay = await admission.lease.grow(growth('inc-lost', 0, 2));
    expect(replay).toMatchObject({ accepted: true, replayed: true });
    expect(admission.lease.reservedByDimension).toEqual([
      { key: 'requests', reservedUnits: 1 },
      { key: 'tokens', reservedUnits: 7 },
    ]);
  });

  it('releases all dimensions on pending expiry but conservatively retains liable expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00Z'));
    const policy: VectorUsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          reservationTtlMs: 20,
          dimensions: [
            { key: 'requests', units: 1, budgets: [{ key: 'req-exp', limit: 1 }] },
            { key: 'tokens', units: 4, budgets: [{ key: 'tok-exp', limit: 4 }] },
          ],
        };
      },
    };
    const store = new MemoryUsageStore({ idempotencyTtlMs: 100 });
    const control = new VectorUsageControl(store, policy);

    const pending = await control.reserve(request('pending-expiry'));
    if (!pending.allowed) throw new Error('expected pending admission');
    await vi.advanceTimersByTimeAsync(21);
    const afterPending = await control.reserve(request('after-pending'));
    expect(afterPending.allowed).toBe(true);
    if (!afterPending.allowed) throw new Error('expected post-pending admission');
    await afterPending.lease.settle(
      [
        { key: 'requests', actualUnits: 0 },
        { key: 'tokens', actualUnits: 0 },
      ],
      'probe',
    );

    const liable = await control.reserve(request('liable-expiry'));
    if (!liable.allowed) throw new Error('expected liable admission');
    await liable.lease.markLiable();
    await vi.advanceTimersByTimeAsync(21);
    const denied = await control.reserve(request('after-liable'));
    expect(denied.allowed).toBe(false);
  });

  it('makes identical vector settlement idempotent and rejects bounds/conflicts', async () => {
    const control = new VectorUsageControl(new MemoryUsageStore(), vectorPolicy);
    const admission = await control.reserve(request('settle'));
    if (!admission.allowed) throw new Error('expected admission');

    await expect(
      admission.lease.settle(
        [
          { key: 'requests', actualUnits: 2 },
          { key: 'tokens', actualUnits: 5 },
        ],
        'bad',
      ),
    ).rejects.toThrow('actualUnits cannot exceed reservedUnits');

    const actual = [
      { key: 'requests', actualUnits: 1 },
      { key: 'tokens', actualUnits: 4 },
    ] as const;
    const first = await admission.lease.settle(actual, 'success');
    expect(await admission.lease.settle(actual, 'success')).toEqual(first);
    await expect(
      admission.lease.settle(
        [
          { key: 'requests', actualUnits: 1 },
          { key: 'tokens', actualUnits: 3 },
        ],
        'success',
      ),
    ).rejects.toThrow('different result');
  });

  it('rejects cross-dimension budget reuse and incomplete growth topology', async () => {
    const badPolicy: VectorUsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          dimensions: [
            { key: 'requests', units: 1, budgets: [{ key: 'shared', limit: 10 }] },
            { key: 'tokens', units: 1, budgets: [{ key: 'shared', limit: 10 }] },
          ],
        };
      },
    };
    await expect(
      new VectorUsageControl(new MemoryUsageStore(), badPolicy).reserve(request('bad-topology')),
    ).rejects.toThrow('budget key cannot appear in multiple vector dimensions');

    const control = new VectorUsageControl(new MemoryUsageStore(), vectorPolicy);
    const admission = await control.reserve(request('growth-topology'));
    if (!admission.allowed) throw new Error('expected admission');
    await expect(
      admission.lease.grow({
        incrementId: 'incomplete',
        dimensions: [
          {
            key: 'tokens',
            additionalUnits: 1,
            budgets: [
              { key: 'tokens:user:user-1', limit: 100 },
              { key: 'tokens:tenant:tenant-1', limit: 100 },
            ],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(UsageStateError);
  });
});
