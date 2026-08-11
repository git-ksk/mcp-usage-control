import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryUsageStore, UsageControl, type UsagePolicy } from './index.js';

const policy: UsagePolicy = {
  quote(request) {
    return {
      decision: 'allow',
      units: 1,
      budgets: [{ key: `monthly:${request.principal.id}`, limit: 1 }],
    };
  },
};

function request(
  operationId: string,
  principalId = 'user-1',
  overrides: Partial<{ tenantId: string; tool: string }> = {},
) {
  return {
    operationId,
    principal: {
      id: principalId,
      plan: 'free',
      ...(overrides.tenantId === undefined ? {} : { tenantId: overrides.tenantId }),
    },
    tool: overrides.tool ?? 'search',
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

  it('admits multiple budgets atomically and never leaves a partial reservation', async () => {
    const store = new MemoryUsageStore();
    const multiPolicy: UsagePolicy = {
      quote(req) {
        return {
          decision: 'allow',
          units: 1,
          budgets: [
            { key: `user:${req.principal.id}:daily`, limit: 2 },
            { key: `tenant:${req.principal.tenantId}:monthly`, limit: 1 },
          ],
        };
      },
    };
    const control = new UsageControl(store, multiPolicy);

    const first = await control.reserve(request('op-a', 'user-1', { tenantId: 'tenant-a' }));
    expect(first.allowed).toBe(true);

    const denied = await control.reserve(request('op-b', 'user-2', { tenantId: 'tenant-a' }));
    expect(denied).toEqual({
      allowed: false,
      reason: 'quota_exceeded',
      limitingBudgetKey: 'tenant:tenant-a:monthly',
      remaining: 0,
    });

    const otherTenant = await control.reserve(request('op-c', 'user-2', { tenantId: 'tenant-b' }));
    expect(otherTenant.allowed).toBe(true);
  });

  it('prevents overlapping users from oversubscribing one shared tenant budget', async () => {
    const sharedPolicy: UsagePolicy = {
      quote(req) {
        return {
          decision: 'allow',
          units: 1,
          budgets: [
            { key: `tenant:${req.principal.tenantId}:monthly`, limit: 1 },
            { key: `user:${req.principal.id}:monthly`, limit: 10 },
          ],
        };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), sharedPolicy);
    const results = await Promise.all([
      control.reserve(request('a', 'user-a', { tenantId: 'tenant-1' })),
      control.reserve(request('b', 'user-b', { tenantId: 'tenant-1' })),
    ]);

    expect(results.filter(result => result.allowed)).toHaveLength(1);
    expect(results.filter(result => !result.allowed)).toHaveLength(1);
  });

  it('releases unused reserved units from every budget on settlement', async () => {
    const multiPolicy: UsagePolicy = {
      quote(req) {
        return {
          decision: 'allow',
          units: 1,
          budgets: [
            { key: `daily:${req.principal.id}`, limit: 1 },
            { key: `monthly:${req.principal.id}`, limit: 1 },
          ],
        };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), multiPolicy);
    const first = await control.reserve(request('op-a'));
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    await first.lease.settle(0, 'pre_execution_failure');
    const second = await control.reserve(request('op-b'));
    expect(second.allowed).toBe(true);
  });

  it('blocks duplicate logical operations within tenant/principal/tool scope', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const first = await control.reserve(request('same-op', 'user-1', { tenantId: 'tenant-a' }));
    expect(first.allowed).toBe(true);

    const duplicate = await control.reserve(request('same-op', 'user-1', { tenantId: 'tenant-a' }));
    expect(duplicate).toEqual({ allowed: false, reason: 'duplicate_operation' });
  });

  it('allows the same operation ID in a different tenant or tool scope', async () => {
    const widePolicy: UsagePolicy = {
      quote() {
        return { decision: 'allow', units: 0, budgets: [{ key: 'shared', limit: 10 }] };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), widePolicy);

    const a = await control.reserve(request('same', 'user-1', { tenantId: 'tenant-a', tool: 'read' }));
    const b = await control.reserve(request('same', 'user-1', { tenantId: 'tenant-b', tool: 'read' }));
    const c = await control.reserve(request('same', 'user-1', { tenantId: 'tenant-a', tool: 'write' }));
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(c.allowed).toBe(true);
  });

  it('does not collide when identity components contain delimiters', async () => {
    const widePolicy: UsagePolicy = {
      quote() {
        return { decision: 'allow', units: 0, budgets: [{ key: 'shared', limit: 10 }] };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), widePolicy);

    const first = await control.reserve(request('b:c', 'a'));
    const second = await control.reserve(request('c', 'a:b'));
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
  });

  it('rejects duplicate budget keys deterministically', async () => {
    const badPolicy: UsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          units: 1,
          budgets: [
            { key: 'same', limit: 2 },
            { key: 'same', limit: 3 },
          ],
        };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), badPolicy);
    await expect(control.reserve(request('op'))).rejects.toThrow('duplicate budget key: same');
  });

  it('makes identical settlement idempotent while the tombstone is retained', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const admission = await control.reserve(request('op-a'));
    if (!admission.allowed) throw new Error('expected admission');

    const first = await admission.lease.settle(1, 'success');
    const second = await admission.lease.settle(1, 'success');
    expect(second).toEqual(first);
  });

  it('allows operation ID reuse after the settled idempotency tombstone expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
    const zeroPolicy: UsagePolicy = {
      quote() {
        return { decision: 'allow', units: 0, budgets: [{ key: 'shared', limit: 1 }] };
      },
    };
    const control = new UsageControl(
      new MemoryUsageStore({ idempotencyTtlMs: 50 }),
      zeroPolicy,
    );
    const first = await control.reserve(request('same'));
    if (!first.allowed) throw new Error('expected admission');
    await first.lease.settle(0, 'success');

    expect(await control.reserve(request('same'))).toEqual({
      allowed: false,
      reason: 'duplicate_operation',
    });
    await vi.advanceTimersByTimeAsync(51);
    expect((await control.reserve(request('same'))).allowed).toBe(true);
  });

  it('keeps an active reservation allocated when its lease is renewed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));

    const expiringPolicy: UsagePolicy = {
      quote(request) {
        return {
          decision: 'allow',
          units: 1,
          budgets: [{ key: `monthly:${request.principal.id}`, limit: 1 }],
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
      limitingBudgetKey: 'monthly:user-1',
      remaining: 0,
    });

    await vi.advanceTimersByTimeAsync(40);
    const afterRenewedLease = await control.reserve(request('op-c'));
    expect(afterRenewedLease.allowed).toBe(true);
  });

  it('releases an expired pending reservation across every budget and permits operation reuse', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
    const expiringPolicy: UsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          units: 1,
          budgets: [
            { key: 'daily:user-1', limit: 1 },
            { key: 'monthly:user-1', limit: 1 },
          ],
          reservationTtlMs: 30,
        };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), expiringPolicy);
    const first = await control.reserve(request('same-op'));
    expect(first.allowed).toBe(true);

    await vi.advanceTimersByTimeAsync(31);
    const second = await control.reserve(request('same-op'));
    expect(second.allowed).toBe(true);
  });

  it('charges every budget in full if a cost-liable lease expires before settlement', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
    const expiringPolicy: UsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          units: 1,
          budgets: [
            { key: 'daily:user-1', limit: 1 },
            { key: 'monthly:user-1', limit: 1 },
          ],
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
    expect(second).toEqual({
      allowed: false,
      reason: 'quota_exceeded',
      limitingBudgetKey: 'daily:user-1',
      remaining: 0,
    });
  });

  it('reattaches to a trusted lease snapshot without quoting or reserving twice', async () => {
    let quoteCalls = 0;
    const resumablePolicy: UsagePolicy = {
      quote(req) {
        quoteCalls += 1;
        return {
          decision: 'allow',
          units: 1,
          budgets: [{ key: `monthly:${req.principal.id}`, limit: 1 }],
          reservationTtlMs: 1_000,
        };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), resumablePolicy);
    const admission = await control.reserve(request('multi-round'));
    if (!admission.allowed) throw new Error('expected admission');
    await admission.lease.markLiable();

    const persisted = JSON.parse(JSON.stringify(admission.lease.toResumeState()));
    const resumed = control.resumeLease(persisted);
    expect(quoteCalls).toBe(1);
    expect(resumed.toResumeState()).toEqual(persisted);

    await resumed.renew(1_000);
    await resumed.settle(0, 'multi_round_success');

    const next = await control.reserve(request('after-resume'));
    expect(next.allowed).toBe(true);
    expect(quoteCalls).toBe(2);
  });

  it('returns detached resume snapshots and validates restored state', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const admission = await control.reserve(request('snapshot'));
    if (!admission.allowed) throw new Error('expected admission');

    const snapshot = admission.lease.toResumeState();
    snapshot.reservation.budgetKeys.push('mutated');
    expect(admission.lease.reservation.budgetKeys).not.toContain('mutated');

    expect(() => control.resumeLease({ ...snapshot, ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() =>
      control.resumeLease({
        ...snapshot,
        ttlMs: 1_000,
        reservation: { ...snapshot.reservation, id: '' },
      }),
    ).toThrow(/id/);
  });
});
