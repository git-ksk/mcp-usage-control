import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryUsageStore,
  UsageControl,
  type ProgressiveUsageStore,
  type UsagePolicy,
} from './index.js';

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


describe('progressive reservation growth', () => {
  const growthBudgets = [{ key: 'growth:user-1', limit: 6 }] as const;
  const growthPolicy: UsagePolicy = {
    quote() {
      return { decision: 'allow', units: 1, budgets: growthBudgets, reservationTtlMs: 1_000 };
    },
  };

  it('grows one logical lease sequentially and settles against the grown total', async () => {
    const control = new UsageControl(new MemoryUsageStore(), growthPolicy);
    const admission = await control.reserve(request('progressive'));
    if (!admission.allowed) throw new Error('expected admission');

    const first = await admission.lease.grow({
      incrementId: 'inc-1',
      additionalUnits: 1,
      budgets: growthBudgets,
    });
    expect(first).toMatchObject({ accepted: true, replayed: false, reservedUnits: 2 });

    const second = await admission.lease.grow({
      incrementId: 'inc-2',
      additionalUnits: 2,
      budgets: growthBudgets,
    });
    expect(second).toMatchObject({ accepted: true, replayed: false, reservedUnits: 4 });
    expect(admission.lease.reservedUnits).toBe(4);

    await expect(admission.lease.settle(5, 'too-much')).rejects.toThrow(/reserved/i);
    await expect(admission.lease.settle(4, 'exact')).resolves.toMatchObject({
      reservedUnits: 4,
      actualUnits: 4,
    });
  });

  it('replays one increment exactly and rejects a conflicting replay without double reserving', async () => {
    const store = new MemoryUsageStore();
    const admission = await store.reserve({
      request: request('replay'),
      units: 1,
      budgets: [{ key: 'growth:replay', limit: 2 }],
      ttlMs: 1_000,
    });
    if (!admission.accepted || !admission.reservation.growthCursor) {
      throw new Error('expected growable admission');
    }
    const input = {
      reservationId: admission.reservation.id,
      incrementId: 'stable-inc',
      expectedGrowthCursor: admission.reservation.growthCursor,
      additionalUnits: 1,
      budgets: [{ key: 'growth:replay', limit: 2 }],
    } as const;

    const first = await store.growReservation(input);
    const replay = await store.growReservation(input);
    expect(first).toMatchObject({ accepted: true, replayed: false, reservedUnits: 2 });
    expect(replay).toMatchObject({ accepted: true, replayed: true, reservedUnits: 2 });

    await expect(
      store.growReservation({ ...input, additionalUnits: 2 }),
    ).rejects.toThrow(/different parameters/i);

    const probe = await store.reserve({
      request: request('replay-probe'),
      units: 1,
      budgets: [{ key: 'growth:replay', limit: 2 }],
      ttlMs: 1_000,
    });
    expect(probe).toMatchObject({ accepted: false, reason: 'quota_exceeded' });
  });

  it('serializes concurrent same and distinct increments through the growth cursor', async () => {
    const sameStore = new MemoryUsageStore();
    const sameAdmission = await sameStore.reserve({
      request: request('concurrent-same'),
      units: 1,
      budgets: [{ key: 'growth:concurrent-same', limit: 2 }],
      ttlMs: 1_000,
    });
    if (!sameAdmission.accepted || !sameAdmission.reservation.growthCursor) {
      throw new Error('expected growable admission');
    }
    const sameInput = {
      reservationId: sameAdmission.reservation.id,
      incrementId: 'same-inc',
      expectedGrowthCursor: sameAdmission.reservation.growthCursor,
      additionalUnits: 1,
      budgets: [{ key: 'growth:concurrent-same', limit: 2 }],
    } as const;
    const sameResults = await Promise.all([
      sameStore.growReservation(sameInput),
      sameStore.growReservation(sameInput),
    ]);
    expect(sameResults.filter(result => result.replayed)).toHaveLength(1);
    expect(sameResults.every(result => result.accepted && result.reservedUnits === 2)).toBe(true);

    const distinctStore = new MemoryUsageStore();
    const distinctAdmission = await distinctStore.reserve({
      request: request('concurrent-distinct'),
      units: 1,
      budgets: [{ key: 'growth:concurrent-distinct', limit: 3 }],
      ttlMs: 1_000,
    });
    if (!distinctAdmission.accepted || !distinctAdmission.reservation.growthCursor) {
      throw new Error('expected growable admission');
    }
    const cursor = distinctAdmission.reservation.growthCursor;
    const distinctResults = await Promise.allSettled([
      distinctStore.growReservation({
        reservationId: distinctAdmission.reservation.id,
        incrementId: 'inc-a',
        expectedGrowthCursor: cursor,
        additionalUnits: 1,
        budgets: [{ key: 'growth:concurrent-distinct', limit: 3 }],
      }),
      distinctStore.growReservation({
        reservationId: distinctAdmission.reservation.id,
        incrementId: 'inc-b',
        expectedGrowthCursor: cursor,
        additionalUnits: 1,
        budgets: [{ key: 'growth:concurrent-distinct', limit: 3 }],
      }),
    ]);
    expect(distinctResults.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(distinctResults.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('rotates the cursor on quota denial and rolls back every budget atomically', async () => {
    const store = new MemoryUsageStore();
    const admission = await store.reserve({
      request: request('multi-growth'),
      units: 1,
      budgets: [
        { key: 'growth:free', limit: 3 },
        { key: 'growth:blocked', limit: 2 },
      ],
      ttlMs: 1_000,
    });
    if (!admission.accepted || !admission.reservation.growthCursor) {
      throw new Error('expected growable admission');
    }
    const blocker = await store.reserve({
      request: request('blocker', 'user-2'),
      units: 1,
      budgets: [{ key: 'growth:blocked', limit: 2 }],
      ttlMs: 1_000,
    });
    expect(blocker.accepted).toBe(true);

    const oldCursor = admission.reservation.growthCursor;
    const deniedInput = {
      reservationId: admission.reservation.id,
      incrementId: 'denied-inc',
      expectedGrowthCursor: oldCursor,
      additionalUnits: 1,
      budgets: [
        { key: 'growth:free', limit: 3 },
        { key: 'growth:blocked', limit: 2 },
      ],
    } as const;
    const denied = await store.growReservation(deniedInput);
    expect(denied).toMatchObject({ accepted: false, reason: 'quota_exceeded', replayed: false });
    expect(denied.growthCursor).not.toBe(oldCursor);
    const replay = await store.growReservation(deniedInput);
    expect(replay).toMatchObject({ accepted: false, reason: 'quota_exceeded', replayed: true });

    await expect(
      store.growReservation({
        ...deniedInput,
        incrementId: 'unrelated-on-stale-cursor',
        budgets: [
          { key: 'growth:free', limit: 4 },
          { key: 'growth:blocked', limit: 3 },
        ],
      }),
    ).rejects.toThrow(/cursor/i);

    const freeProbe = await store.reserve({
      request: request('free-probe'),
      units: 2,
      budgets: [{ key: 'growth:free', limit: 3 }],
      ttlMs: 1_000,
    });
    expect(freeProbe.accepted).toBe(true);
  });

  it('replays an authoritative quota denial after its acknowledgement is lost', async () => {
    const inner = new MemoryUsageStore();
    let loseFirstAck = true;
    const store: ProgressiveUsageStore = {
      reserve: input => inner.reserve(input),
      markLiable: input => inner.markLiable(input),
      renew: input => inner.renew(input),
      settle: input => inner.settle(input),
      async growReservation(input) {
        const result = await inner.growReservation(input);
        if (loseFirstAck) {
          loseFirstAck = false;
          throw new Error('transport lost after authoritative denial');
        }
        return result;
      },
    };
    const denialPolicy: UsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          units: 1,
          budgets: [{ key: 'growth:denial-lost-ack', limit: 1 }],
          reservationTtlMs: 1_000,
        };
      },
    };
    const control = new UsageControl(store, denialPolicy);
    const admission = await control.reserve(request('denial-lost-ack'));
    if (!admission.allowed) throw new Error('expected admission');
    const attempt = {
      incrementId: 'stable-denied-growth',
      additionalUnits: 1,
      budgets: [{ key: 'growth:denial-lost-ack', limit: 1 }],
    } as const;

    await expect(admission.lease.grow(attempt)).rejects.toThrow(/authoritative denial/);
    await expect(
      admission.lease.grow({ ...attempt, incrementId: 'fresh-id-after-lost-denial' }),
    ).rejects.toThrow(/unresolved/i);

    const replay = await admission.lease.grow(attempt);
    expect(replay).toMatchObject({
      accepted: false,
      reason: 'quota_exceeded',
      replayed: true,
    });

    const nextAttempt = await admission.lease.grow({
      incrementId: 'next-after-known-denial',
      additionalUnits: 1,
      budgets: [{ key: 'growth:denial-lost-ack', limit: 2 }],
    });
    expect(nextAttempt).toMatchObject({ accepted: true, reservedUnits: 2 });
  });

  it('preserves pending and liable expiry semantics after growth', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00Z'));

    const pendingStore = new MemoryUsageStore();
    const pending = await pendingStore.reserve({
      request: request('pending-grown'),
      units: 1,
      budgets: [{ key: 'growth:pending', limit: 3 }],
      ttlMs: 30,
    });
    if (!pending.accepted || !pending.reservation.growthCursor) throw new Error('expected pending');
    await pendingStore.growReservation({
      reservationId: pending.reservation.id,
      incrementId: 'pending-inc',
      expectedGrowthCursor: pending.reservation.growthCursor,
      additionalUnits: 2,
      budgets: [{ key: 'growth:pending', limit: 3 }],
    });
    await vi.advanceTimersByTimeAsync(31);
    await expect(
      pendingStore.growReservation({
        reservationId: pending.reservation.id,
        incrementId: 'after-expiry',
        expectedGrowthCursor: pending.reservation.growthCursor,
        additionalUnits: 1,
        budgets: [{ key: 'growth:pending', limit: 4 }],
      }),
    ).rejects.toThrow(/not found|expired/i);
    const replacement = await pendingStore.reserve({
      request: request('pending-replacement'),
      units: 3,
      budgets: [{ key: 'growth:pending', limit: 3 }],
      ttlMs: 1_000,
    });
    expect(replacement.accepted).toBe(true);

    const liableStore = new MemoryUsageStore();
    const liable = await liableStore.reserve({
      request: request('liable-grown'),
      units: 1,
      budgets: [{ key: 'growth:liable', limit: 2 }],
      ttlMs: 30,
    });
    if (!liable.accepted || !liable.reservation.growthCursor) throw new Error('expected liable');
    await liableStore.markLiable({ reservationId: liable.reservation.id });
    await liableStore.growReservation({
      reservationId: liable.reservation.id,
      incrementId: 'liable-inc',
      expectedGrowthCursor: liable.reservation.growthCursor,
      additionalUnits: 1,
      budgets: [{ key: 'growth:liable', limit: 2 }],
    });
    await vi.advanceTimersByTimeAsync(31);
    const liableReplacement = await liableStore.reserve({
      request: request('liable-replacement'),
      units: 1,
      budgets: [{ key: 'growth:liable', limit: 2 }],
      ttlMs: 1_000,
    });
    expect(liableReplacement).toMatchObject({ accepted: false, reason: 'quota_exceeded' });
  });

  it('rejects new growth after settlement and keeps grow/settle races serialized', async () => {
    const settledStore = new MemoryUsageStore();
    const settled = await settledStore.reserve({
      request: request('settled-growth'),
      units: 1,
      budgets: [{ key: 'growth:settled', limit: 2 }],
      ttlMs: 1_000,
    });
    if (!settled.accepted || !settled.reservation.growthCursor) throw new Error('expected settled');
    const settledCursor = settled.reservation.growthCursor;
    await settledStore.settle({ reservationId: settled.reservation.id, actualUnits: 1, outcome: 'done' });
    await expect(
      settledStore.growReservation({
        reservationId: settled.reservation.id,
        incrementId: 'after-settle',
        expectedGrowthCursor: settledCursor,
        additionalUnits: 1,
        budgets: [{ key: 'growth:settled', limit: 2 }],
      }),
    ).rejects.toThrow(/settled/i);

    const raceStore = new MemoryUsageStore();
    const raced = await raceStore.reserve({
      request: request('grow-settle-race'),
      units: 1,
      budgets: [{ key: 'growth:race', limit: 2 }],
      ttlMs: 1_000,
    });
    if (!raced.accepted || !raced.reservation.growthCursor) throw new Error('expected race');
    const results = await Promise.allSettled([
      raceStore.growReservation({
        reservationId: raced.reservation.id,
        incrementId: 'race-inc',
        expectedGrowthCursor: raced.reservation.growthCursor,
        additionalUnits: 1,
        budgets: [{ key: 'growth:race', limit: 2 }],
      }),
      raceStore.settle({ reservationId: raced.reservation.id, actualUnits: 1, outcome: 'race' }),
    ]);
    expect(results[1]!.status).toBe('fulfilled');
    if (results[0]!.status === 'fulfilled' && results[1]!.status === 'fulfilled') {
      expect(results[0]!.value).toMatchObject({ accepted: true, reservedUnits: 2 });
      expect(results[1]!.value.reservedUnits).toBe(2);
    }
  });

  it.each(['before', 'after'] as const)(
    'fails closed across a lost ACK %s the growth commit and requires the same increment identity',
    async ambiguityPoint => {
      const inner = new MemoryUsageStore();
      let firstAttempt = true;
      const store: ProgressiveUsageStore = {
        reserve: input => inner.reserve(input),
        markLiable: input => inner.markLiable(input),
        renew: input => inner.renew(input),
        settle: input => inner.settle(input),
        async growReservation(input) {
          if (!firstAttempt) return inner.growReservation(input);
          firstAttempt = false;
          if (ambiguityPoint === 'before') throw new Error('transport lost before commit');
          await inner.growReservation(input);
          throw new Error('transport lost after commit');
        },
      };
      const control = new UsageControl(store, growthPolicy);
      const admission = await control.reserve(request(`lost-ack-${ambiguityPoint}`));
      if (!admission.allowed) throw new Error('expected admission');
      const attempt = { incrementId: 'stable-lost-ack', additionalUnits: 1, budgets: growthBudgets };

      await expect(admission.lease.grow(attempt)).rejects.toThrow(/transport lost/);
      await expect(
        admission.lease.grow({ ...attempt, incrementId: 'fresh-id-is-forbidden' }),
      ).rejects.toThrow(/unresolved/i);

      const snapshot = admission.lease.toResumeState();
      expect(snapshot.unresolvedGrowth?.incrementId).toBe('stable-lost-ack');
      const resumed = control.resumeLease(snapshot);
      const retry = await resumed.grow(attempt);
      expect(retry).toMatchObject({ accepted: true, reservedUnits: 2 });
      expect(retry.replayed).toBe(ambiguityPoint === 'after');

      const next = await resumed.grow({
        incrementId: 'next-after-resolution',
        additionalUnits: 1,
        budgets: growthBudgets,
      });
      expect(next).toMatchObject({ accepted: true, reservedUnits: 3 });
    },
  );
});
