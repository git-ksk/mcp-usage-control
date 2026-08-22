import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryUsageStore,
  MemoryUsageStoreCapacityError,
  UsageStateError,
  type StoreReserveResult,
} from './index.js';

function reserve(
  store: MemoryUsageStore,
  operationId: string,
  budgetKey: string,
  options: { units?: number; limit?: number; ttlMs?: number } = {},
): Promise<StoreReserveResult> {
  return store.reserve({
    request: {
      operationId,
      principal: { id: 'user-1' },
      tool: 'search',
      args: {},
    },
    units: options.units ?? 1,
    budgets: [{ key: budgetKey, limit: options.limit ?? 1 }],
    ttlMs: options.ttlMs ?? 1_000,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MemoryUsageStore operational retention', () => {
  it('fails closed at the budget-key limit without evicting retained usage', async () => {
    const store = new MemoryUsageStore({ maxRetainedBudgetKeys: 1, maxRetainedOperations: 10 });
    const first = await reserve(store, 'op-a', 'day:user-1:2026-08-13');
    if (!first.accepted) throw new Error('expected first reservation');
    await store.settle({ reservationId: first.reservation.id, actualUnits: 1, outcome: 'success' });

    await expect(reserve(store, 'op-b', 'day:user-1:2026-08-14')).rejects.toMatchObject({
      name: 'MemoryUsageStoreCapacityError',
      resource: 'budget_keys',
      limit: 1,
    });

    const sameBudget = await reserve(store, 'op-c', 'day:user-1:2026-08-13');
    expect(sameBudget).toEqual({
      accepted: false,
      reason: 'quota_exceeded',
      limitingBudgetKey: 'day:user-1:2026-08-13',
      remaining: 0,
    });
    expect(store.stats().retainedBudgetKeys).toBe(1);
  });

  it('fails closed at the operation-retention limit until tombstones expire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));
    const store = new MemoryUsageStore({
      idempotencyTtlMs: 50,
      maxRetainedOperations: 1,
      maxRetainedBudgetKeys: 1,
    });

    const first = await reserve(store, 'op-a', 'shared', { units: 0, limit: 1 });
    if (!first.accepted) throw new Error('expected first reservation');
    await store.settle({ reservationId: first.reservation.id, actualUnits: 0, outcome: 'success' });

    await expect(reserve(store, 'op-b', 'shared', { units: 0, limit: 1 })).rejects.toBeInstanceOf(
      MemoryUsageStoreCapacityError,
    );

    await vi.advanceTimersByTimeAsync(51);
    expect((await reserve(store, 'op-b', 'shared', { units: 0, limit: 1 })).accepted).toBe(true);
  });

  it('does not retain zero-unit budget keys', async () => {
    const store = new MemoryUsageStore({ maxRetainedBudgetKeys: 1, maxRetainedOperations: 10 });

    for (let index = 0; index < 3; index += 1) {
      const result = await reserve(store, `zero-${index}`, `unique-${index}`, {
        units: 0,
        limit: 1,
      });
      if (!result.accepted) throw new Error('expected zero-unit reservation');
      await store.settle({
        reservationId: result.reservation.id,
        actualUnits: 0,
        outcome: 'success',
      });
    }

    expect(store.stats()).toMatchObject({
      retainedOperations: 3,
      retainedBudgetKeys: 0,
      maxRetainedBudgetKeys: 1,
    });
  });

  it('rejects scalar growth that would create a retained budget key above capacity', async () => {
    const store = new MemoryUsageStore({ maxRetainedBudgetKeys: 1, maxRetainedOperations: 10 });
    const anchor = await reserve(store, 'growth-anchor', 'retained', { units: 1, limit: 2 });
    if (!anchor.accepted) throw new Error('expected anchor reservation');
    const zero = await reserve(store, 'growth-zero', 'new-budget', { units: 0, limit: 2 });
    if (!zero.accepted || !zero.reservation.growthCursor) throw new Error('expected growable zero reservation');
    const cursor = zero.reservation.growthCursor;
    const growth = {
      reservationId: zero.reservation.id,
      incrementId: 'capacity-growth',
      expectedGrowthCursor: cursor,
      additionalUnits: 1,
      budgets: [{ key: 'new-budget', limit: 2 }],
    } as const;

    await expect(store.growReservation(growth)).rejects.toMatchObject({
      name: 'MemoryUsageStoreCapacityError',
      resource: 'budget_keys',
      limit: 1,
    });
    expect(store.stats().retainedBudgetKeys).toBe(1);

    await store.settle({ reservationId: anchor.reservation.id, actualUnits: 1, outcome: 'done' });
    expect(store.retireBudgetKey('retained')).toBe(true);

    // Capacity rejection did not advance cursor/replay metadata, so the exact
    // original growth remains valid once capacity is available.
    await expect(store.growReservation(growth)).resolves.toMatchObject({
      accepted: true,
      replayed: false,
      reservedUnits: 1,
    });
    expect(store.stats().retainedBudgetKeys).toBe(1);
  });

  it('allows scalar growth on an already-retained budget while exactly at capacity', async () => {
    const store = new MemoryUsageStore({ maxRetainedBudgetKeys: 1, maxRetainedOperations: 10 });
    const anchor = await reserve(store, 'existing-anchor', 'shared-retained', { units: 1, limit: 3 });
    if (!anchor.accepted) throw new Error('expected anchor reservation');
    const zero = await reserve(store, 'existing-zero', 'shared-retained', { units: 0, limit: 3 });
    if (!zero.accepted || !zero.reservation.growthCursor) throw new Error('expected zero reservation');

    await expect(
      store.growReservation({
        reservationId: zero.reservation.id,
        incrementId: 'existing-growth',
        expectedGrowthCursor: zero.reservation.growthCursor,
        additionalUnits: 1,
        budgets: [{ key: 'shared-retained', limit: 3 }],
      }),
    ).resolves.toMatchObject({ accepted: true, reservedUnits: 1 });
    expect(store.stats().retainedBudgetKeys).toBe(1);
  });

  it('rejects vector growth atomically when one new non-zero budget exceeds capacity', async () => {
    const store = new MemoryUsageStore({ maxRetainedBudgetKeys: 2, maxRetainedOperations: 20 });
    const existing = await reserve(store, 'vector-existing', 'vector-existing-budget', { units: 1, limit: 2 });
    if (!existing.accepted) throw new Error('expected existing reservation');
    const blocker = await reserve(store, 'vector-blocker', 'vector-blocker-budget', { units: 1, limit: 2 });
    if (!blocker.accepted) throw new Error('expected blocker reservation');
    await store.settle({ reservationId: blocker.reservation.id, actualUnits: 1, outcome: 'done' });

    const vector = await store.reserveVector({
      request: {
        operationId: 'vector-zero',
        principal: { id: 'user-1' },
        tool: 'search',
        args: {},
      },
      dimensions: [
        { key: 'existing', units: 0, budgets: [{ key: 'vector-existing-budget', limit: 2 }] },
        { key: 'new', units: 0, budgets: [{ key: 'vector-new-budget', limit: 2 }] },
      ],
      ttlMs: 1_000,
    });
    if (!vector.accepted || !vector.reservation.growthCursor) throw new Error('expected vector reservation');
    const growth = {
      reservationId: vector.reservation.id,
      incrementId: 'vector-capacity-growth',
      expectedGrowthCursor: vector.reservation.growthCursor,
      dimensions: [
        { key: 'existing', additionalUnits: 1, budgets: [{ key: 'vector-existing-budget', limit: 2 }] },
        { key: 'new', additionalUnits: 1, budgets: [{ key: 'vector-new-budget', limit: 2 }] },
      ],
    } as const;

    await expect(store.growVectorReservation(growth)).rejects.toMatchObject({
      name: 'MemoryUsageStoreCapacityError',
      resource: 'budget_keys',
      limit: 2,
    });
    expect(store.stats().retainedBudgetKeys).toBe(2);

    // No partial increment was applied to the already-retained dimension.
    const probe = await reserve(store, 'vector-no-partial-probe', 'vector-existing-budget', { units: 1, limit: 2 });
    expect(probe).toMatchObject({ accepted: true });
    if (!probe.accepted) throw new Error('capacity rejection partially mutated existing usage');
    await store.settle({ reservationId: probe.reservation.id, actualUnits: 0, outcome: 'probe' });

    expect(store.retireBudgetKey('vector-blocker-budget')).toBe(true);
    await expect(store.growVectorReservation(growth)).resolves.toMatchObject({
      accepted: true,
      replayed: false,
    });
    expect(store.stats().retainedBudgetKeys).toBe(2);
  });

  it('allows explicit retirement of a completed time-window budget key', async () => {
    const store = new MemoryUsageStore({ maxRetainedBudgetKeys: 1, maxRetainedOperations: 10 });
    const first = await reserve(store, 'day-1', 'day:user-1:2026-08-13');
    if (!first.accepted) throw new Error('expected first reservation');
    await store.settle({ reservationId: first.reservation.id, actualUnits: 1, outcome: 'success' });

    expect(store.retireBudgetKey('day:user-1:2026-08-13')).toBe(true);
    expect(store.stats().retainedBudgetKeys).toBe(0);

    expect((await reserve(store, 'day-2', 'day:user-1:2026-08-14')).accepted).toBe(true);
  });

  it('refuses to retire a budget key while an active reservation references it', async () => {
    const store = new MemoryUsageStore({ maxRetainedBudgetKeys: 2, maxRetainedOperations: 10 });
    const active = await reserve(store, 'active', 'day:user-1:2026-08-13');
    if (!active.accepted) throw new Error('expected active reservation');

    expect(() => store.retireBudgetKey('day:user-1:2026-08-13')).toThrow(UsageStateError);
    expect(store.stats().retainedBudgetKeys).toBe(1);
  });
});
