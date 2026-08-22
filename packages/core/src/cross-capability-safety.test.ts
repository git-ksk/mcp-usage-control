import { describe, expect, it } from 'vitest';
import { MemoryUsageStore, createWindowedBudgetKey } from './index.js';

const request = (operationId: string) => ({
  operationId,
  principal: { id: 'user-1', plan: 'free' },
  tool: 'cross-capability',
  args: {},
});

describe('cross-capability safety matrix', () => {
  it('keeps bounded Memory retention fail-closed across zero-unit scalar and vector growth', async () => {
    const scalar = new MemoryUsageStore({ maxRetainedBudgetKeys: 1, maxRetainedOperations: 10 });
    expect((await scalar.reserve({
      request: request('scalar-seed'), units: 1, budgets: [{ key: 'retained', limit: 10 }], ttlMs: 5_000,
    })).accepted).toBe(true);
    const zero = await scalar.reserve({
      request: request('scalar-zero'), units: 0, budgets: [{ key: 'new-budget', limit: 10 }], ttlMs: 5_000,
    });
    if (!zero.accepted || !zero.reservation.growthCursor) throw new Error('expected growable zero reservation');
    await expect(scalar.growReservation({
      reservationId: zero.reservation.id,
      incrementId: 'scalar-growth',
      expectedGrowthCursor: zero.reservation.growthCursor,
      additionalUnits: 1,
      budgets: [{ key: 'new-budget', limit: 10 }],
    })).rejects.toMatchObject({ name: 'MemoryUsageStoreCapacityError', resource: 'budget_keys' });
    expect(scalar.stats().retainedBudgetKeys).toBe(1);

    const vector = new MemoryUsageStore({ maxRetainedBudgetKeys: 1, maxRetainedOperations: 10 });
    expect((await vector.reserve({
      request: request('vector-seed'), units: 1, budgets: [{ key: 'retained', limit: 10 }], ttlMs: 5_000,
    })).accepted).toBe(true);
    const vectorZero = await vector.reserveVector({
      request: request('vector-zero'),
      dimensions: [{ key: 'tokens', units: 0, budgets: [{ key: 'vector-new', limit: 10 }] }],
      ttlMs: 5_000,
    });
    if (!vectorZero.accepted || !vectorZero.reservation.growthCursor) throw new Error('expected growable vector reservation');
    await expect(vector.growVectorReservation({
      reservationId: vectorZero.reservation.id,
      incrementId: 'vector-growth',
      expectedGrowthCursor: vectorZero.reservation.growthCursor,
      dimensions: [{ key: 'tokens', additionalUnits: 1, budgets: [{ key: 'vector-new', limit: 10 }] }],
    })).rejects.toMatchObject({ name: 'MemoryUsageStoreCapacityError', resource: 'budget_keys' });
    expect(vector.stats().retainedBudgetKeys).toBe(1);
  });

  it('keeps mutable limits and replay pinned to the original windowed accounting key', async () => {
    const monthly = createWindowedBudgetKey({ period: 'calendar-month', timeZone: 'UTC', namespace: 'credits' });
    const augustKey = monthly.key({ scope: 'user', id: 'user-1', now: Date.parse('2026-08-31T23:59:59.999Z') });
    const septemberKey = monthly.key({ scope: 'user', id: 'user-1', now: Date.parse('2026-09-01T00:00:00.000Z') });
    const store = new MemoryUsageStore();
    const reserved = await store.reserve({
      request: request('windowed-growth'), units: 1, budgets: [{ key: augustKey, limit: 2 }], ttlMs: 5_000,
    });
    if (!reserved.accepted || !reserved.reservation.growthCursor) throw new Error('expected growable reservation');
    const growthInput = {
      reservationId: reserved.reservation.id,
      incrementId: 'stable-increment',
      expectedGrowthCursor: reserved.reservation.growthCursor,
      additionalUnits: 1,
      budgets: [{ key: augustKey, limit: 3 }],
    } as const;
    await expect(
      store.growReservation({
        ...growthInput,
        incrementId: 'wrong-window',
        budgets: [{ key: septemberKey, limit: 3 }],
      }),
    ).rejects.toThrow(/budget set/);

    const grown = await store.growReservation(growthInput);
    expect(grown).toMatchObject({ accepted: true, replayed: false, reservedUnits: 2 });
    await expect(store.growReservation(growthInput)).resolves.toMatchObject({
      accepted: true,
      replayed: true,
      reservedUnits: 2,
    });
  });
});
