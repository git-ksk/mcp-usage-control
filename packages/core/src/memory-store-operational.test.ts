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
