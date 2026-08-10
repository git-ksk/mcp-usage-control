import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryUsageStore, UsageControl, type UsagePolicy } from './index.js';

const policy: UsagePolicy = {
  quote(request) {
    return {
      decision: 'allow',
      units: 1,
      budget: { key: `monthly:${request.principal.id}`, limit: 1 },
    };
  },
};

function request(operationId: string, principalId = 'user-1') {
  return {
    operationId,
    principal: { id: principalId, plan: 'free' },
    tool: 'search',
    args: {},
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('UsageControl', () => {
  it('prevents parallel oversubscription', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const results = await Promise.all([
      control.reserve(request('op-a')),
      control.reserve(request('op-b')),
    ]);

    expect(results.filter(result => result.allowed)).toHaveLength(1);
    expect(results.filter(result => !result.allowed && result.reason === 'quota_exceeded')).toHaveLength(1);
  });

  it('releases unused reserved units on settlement', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const first = await control.reserve(request('op-a'));
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    await first.lease.settle(0, 'pre_execution_failure');
    const second = await control.reserve(request('op-b'));
    expect(second.allowed).toBe(true);
  });

  it('blocks duplicate operation IDs', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const first = await control.reserve(request('same-op'));
    expect(first.allowed).toBe(true);

    const duplicate = await control.reserve(request('same-op'));
    expect(duplicate).toEqual({ allowed: false, reason: 'duplicate_operation' });
  });

  it('does not collide when principal and operation IDs contain delimiters', async () => {
    const store = new MemoryUsageStore();
    const widePolicy: UsagePolicy = {
      quote() {
        return { decision: 'allow', units: 0, budget: { key: 'shared', limit: 10 } };
      },
    };
    const control = new UsageControl(store, widePolicy);

    const first = await control.reserve(request('b:c', 'a'));
    const second = await control.reserve(request('c', 'a:b'));
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
  });

  it('makes identical settlement idempotent', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const admission = await control.reserve(request('op-a'));
    if (!admission.allowed) throw new Error('expected admission');

    const first = await admission.lease.settle(1, 'success');
    const second = await admission.lease.settle(1, 'success');
    expect(second).toEqual(first);
  });

  it('keeps an active reservation allocated when its lease is renewed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));

    const expiringPolicy: UsagePolicy = {
      quote(request) {
        return {
          decision: 'allow',
          units: 1,
          budget: { key: `monthly:${request.principal.id}`, limit: 1 },
          reservationTtlMs: 30,
        };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), expiringPolicy);
    const first = await control.reserve(request('op-a'));
    if (!first.allowed) throw new Error('expected admission');

    await vi.advanceTimersByTimeAsync(20);
    await first.lease.renew(50);
    await vi.advanceTimersByTimeAsync(20);

    const duringRenewedLease = await control.reserve(request('op-b'));
    expect(duringRenewedLease).toEqual({
      allowed: false,
      reason: 'quota_exceeded',
      remaining: 0,
    });

    await vi.advanceTimersByTimeAsync(40);
    const afterRenewedLease = await control.reserve(request('op-c'));
    expect(afterRenewedLease.allowed).toBe(true);
  });

  it('releases an expired reservation that never became cost-liable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
    const expiringPolicy: UsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          units: 1,
          budget: { key: 'monthly:user-1', limit: 1 },
          reservationTtlMs: 30,
        };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), expiringPolicy);
    const first = await control.reserve(request('op-a'));
    expect(first.allowed).toBe(true);

    await vi.advanceTimersByTimeAsync(31);
    const second = await control.reserve(request('op-b'));
    expect(second.allowed).toBe(true);
  });

  it('charges the full reservation if a cost-liable lease expires before settlement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
    const expiringPolicy: UsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          units: 1,
          budget: { key: 'monthly:user-1', limit: 1 },
          reservationTtlMs: 30,
        };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), expiringPolicy);
    const first = await control.reserve(request('op-a'));
    if (!first.allowed) throw new Error('expected admission');
    await first.lease.markLiable();

    await vi.advanceTimersByTimeAsync(31);
    const second = await control.reserve(request('op-b'));
    expect(second).toEqual({ allowed: false, reason: 'quota_exceeded', remaining: 0 });
  });
});
