import { describe, expect, it } from 'vitest';
import { MemoryUsageStore, type UsageDimension } from './index.js';

const request = {
  operationId: 'vector-reconcile',
  principal: { id: 'user-1', tenantId: 'tenant-1', plan: 'plus' },
  tool: 'generate',
  args: {},
};
const dimensions: UsageDimension[] = [
  { key: 'requests', units: 1, budgets: [{ key: 'day:user-1', limit: 10 }] },
  { key: 'tokens', units: 5, budgets: [{ key: 'month:tenant-1', limit: 100 }] },
];

describe('vector operation reconciliation', () => {
  it('reattaches only to the exact active topology and reports settlement read-only', async () => {
    const store = new MemoryUsageStore();
    expect(await store.reconcileVectorOperation({ request, dimensions })).toEqual({
      status: 'absent',
      reservationId: expect.any(String),
    });
    const reserved = await store.reserveVector({ request, dimensions, ttlMs: 5_000 });
    expect(reserved.accepted).toBe(true);
    if (!reserved.accepted) return;

    const active = await store.reconcileVectorOperation({ request, dimensions });
    expect(active).toMatchObject({ status: 'active', state: 'pending' });
    await expect(store.reconcileVectorOperation({
      request,
      dimensions: [{ ...dimensions[0]!, units: 2 }, dimensions[1]!],
    })).rejects.toThrow(/does not match retained reservation state/);

    await store.markLiable({ reservationId: reserved.reservation.id });
    expect(await store.reconcileVectorOperation({ request, dimensions })).toMatchObject({
      status: 'active', state: 'liable',
    });
    await store.settleVector({
      reservationId: reserved.reservation.id,
      actualByDimension: [
        { key: 'requests', actualUnits: 1 },
        { key: 'tokens', actualUnits: 3 },
      ],
      outcome: 'completed',
    });
    expect(await store.reconcileVectorOperation({ request, dimensions })).toMatchObject({
      status: 'settled',
      reservedByDimension: [
        { key: 'requests', reservedUnits: 1 },
        { key: 'tokens', reservedUnits: 5 },
      ],
      actualByDimension: [
        { key: 'requests', actualUnits: 1 },
        { key: 'tokens', actualUnits: 3 },
      ],
    });
  });
});
