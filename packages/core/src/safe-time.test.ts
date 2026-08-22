import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryUsageStore } from './index.js';

const BASE = Date.parse('2026-08-22T00:00:00Z');
const request = (operationId: string) => ({
  operationId,
  principal: { id: 'user-1', tenantId: 'tenant-1', plan: 'free' },
  tool: 'safe-time',
  args: {},
});

const scalarInput = (operationId: string, ttlMs: number) => ({
  request: request(operationId),
  units: 1,
  budgets: [{ key: 'shared', limit: 1 }],
  ttlMs,
});

const vectorInput = (operationId: string, ttlMs: number) => ({
  request: request(operationId),
  dimensions: [
    { key: 'requests', units: 1, budgets: [{ key: 'vector-shared', limit: 1 }] },
  ],
  ttlMs,
});

afterEach(() => vi.useRealTimers());

describe('MemoryUsageStore safe time arithmetic', () => {
  it('rejects unsafe scalar expiry before retaining operation or budget state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const store = new MemoryUsageStore();

    await expect(store.reserve(scalarInput('unsafe-scalar', Number.MAX_SAFE_INTEGER))).rejects.toThrow(
      /reservation expiry exceeds safe integer range/,
    );
    expect(store.stats()).toMatchObject({ retainedOperations: 0, retainedBudgetKeys: 0 });

    await expect(store.reserve(scalarInput('after-unsafe-scalar', 1_000))).resolves.toMatchObject({
      accepted: true,
    });
  });

  it('rejects unsafe vector expiry before retaining operation or budget state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const store = new MemoryUsageStore();

    await expect(store.reserveVector(vectorInput('unsafe-vector', Number.MAX_SAFE_INTEGER))).rejects.toThrow(
      /reservation expiry exceeds safe integer range/,
    );
    expect(store.stats()).toMatchObject({ retainedOperations: 0, retainedBudgetKeys: 0 });
  });

  it('rejects unsafe renewal without changing the active lease or accounting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const store = new MemoryUsageStore();
    const first = await store.reserve(scalarInput('renew-source', 1_000));
    if (!first.accepted) throw new Error('expected reservation');
    const originalExpiry = first.reservation.expiresAt;

    await expect(
      store.renew({ reservationId: first.reservation.id, ttlMs: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow(/reservation expiry exceeds safe integer range/);

    const state = await store.reconcileOperation({
      request: request('renew-source'),
      units: 1,
      budgets: [{ key: 'shared', limit: 1 }],
    });
    expect(state).toMatchObject({ status: 'active', reservation: { expiresAt: originalExpiry } });
    await expect(store.reserve(scalarInput('renew-probe', 1_000))).resolves.toMatchObject({
      accepted: false,
      reason: 'quota_exceeded',
    });
  });

  it('rejects unsafe scalar tombstone expiry before releasing capacity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const store = new MemoryUsageStore({ idempotencyTtlMs: Number.MAX_SAFE_INTEGER });
    const first = await store.reserve(scalarInput('settle-source', 1_000));
    if (!first.accepted) throw new Error('expected reservation');

    await expect(
      store.settle({ reservationId: first.reservation.id, actualUnits: 0, outcome: 'done' }),
    ).rejects.toThrow(/tombstone expiry exceeds safe integer range/);

    await expect(store.reserve(scalarInput('settle-probe', 1_000))).resolves.toMatchObject({
      accepted: false,
      reason: 'quota_exceeded',
    });
  });

  it('rejects unsafe vector tombstone expiry before releasing capacity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const store = new MemoryUsageStore({ idempotencyTtlMs: Number.MAX_SAFE_INTEGER });
    const first = await store.reserveVector(vectorInput('vector-settle-source', 1_000));
    if (!first.accepted) throw new Error('expected vector reservation');

    await expect(
      store.settleVector({
        reservationId: first.reservation.id,
        actualByDimension: [{ key: 'requests', actualUnits: 0 }],
        outcome: 'done',
      }),
    ).rejects.toThrow(/tombstone expiry exceeds safe integer range/);

    await expect(store.reserveVector(vectorInput('vector-settle-probe', 1_000))).resolves.toMatchObject({
      accepted: false,
      reason: 'quota_exceeded',
    });
  });

  it('preflights liable recovery before changing any reservation state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    const store = new MemoryUsageStore({ idempotencyTtlMs: Number.MAX_SAFE_INTEGER });
    const first = await store.reserve(scalarInput('liable-source', 20));
    if (!first.accepted) throw new Error('expected reservation');
    await store.markLiable({ reservationId: first.reservation.id });

    vi.setSystemTime(BASE + 25);
    await expect(store.reserve(scalarInput('recovery-trigger', 1_000))).rejects.toThrow(
      /tombstone expiry exceeds safe integer range/,
    );

    // Move the test clock back inside the original lease so inspection itself
    // does not attempt the intentionally-invalid recovery transition.
    vi.setSystemTime(BASE + 10);
    await expect(
      store.reconcileOperation({
        request: request('liable-source'),
        units: 1,
        budgets: [{ key: 'shared', limit: 1 }],
      }),
    ).resolves.toMatchObject({ status: 'active', state: 'liable' });
    expect(store.stats()).toMatchObject({ retainedOperations: 1, retainedBudgetKeys: 1 });
  });
});
