import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from 'redis';
import {
  UsageControl,
  VectorUsageControl,
  type UsageEvent,
  type UsagePolicy,
  type VectorUsagePolicy,
} from 'mcp-usage-control';
import { RedisUsageStore, type RedisEvalClient } from './index.js';

const redisUrl = process.env.REDIS_URL;
const integration = redisUrl ? describe : describe.skip;
const client = createClient({ url: redisUrl ?? 'redis://127.0.0.1:6379' });

const request = (
  operationId: string,
  principalId = 'user-1',
  overrides: Partial<{ tenantId: string; tool: string }> = {},
) => ({
  operationId,
  principal: {
    id: principalId,
    plan: 'free',
    ...(overrides.tenantId === undefined ? {} : { tenantId: overrides.tenantId }),
  },
  tool: overrides.tool ?? 'search',
  args: {},
});

function policy(limit = 1, reservationTtlMs = 5_000): UsagePolicy {
  return {
    quote() {
      return {
        decision: 'allow',
        units: 1,
        budgets: [{ key: 'month:user-1:2026-08', limit }],
        reservationTtlMs,
      };
    },
  };
}

function vectorPolicy(reservationTtlMs = 5_000): VectorUsagePolicy {
  return {
    quote() {
      return {
        decision: 'allow',
        reservationTtlMs,
        dimensions: [
          { key: 'requests', units: 1, budgets: [{ key: 'vector:requests', limit: 2 }] },
          { key: 'tokens', units: 5, budgets: [{ key: 'vector:tokens', limit: 20 }] },
        ],
      };
    },
  };
}

function multiPolicy(limit = 1, reservationTtlMs = 5_000): UsagePolicy {
  return {
    quote(req) {
      return {
        decision: 'allow',
        units: 1,
        budgets: [
          { key: `tenant:${req.principal.tenantId}:monthly`, limit },
          { key: `user:${req.principal.id}:daily`, limit: 10 },
        ],
        reservationTtlMs,
      };
    },
  };
}

class LoseNextReplyClient implements RedisEvalClient {
  loseNextReply = false;
  constructor(private readonly inner: RedisEvalClient) {}
  async eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> {
    const reply = await this.inner.eval(script, options);
    if (this.loseNextReply) {
      this.loseNextReply = false;
      throw new Error('simulated lost Redis acknowledgement');
    }
    return reply;
  }
}

integration('RedisUsageStore', () => {
  beforeAll(async () => { await client.connect(); });
  beforeEach(async () => { vi.restoreAllMocks(); await client.flushDb(); });
  afterAll(async () => { await client.quit(); });

  it('admits exactly one of 100 concurrent calls when one unit remains', async () => {
    const control = new UsageControl(new RedisUsageStore(client), policy(1));
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) => control.reserve(request(`op-${index}`))),
    );
    expect(results.filter(result => result.allowed)).toHaveLength(1);
    expect(results.filter(result => !result.allowed && result.reason === 'quota_exceeded')).toHaveLength(99);
  });

  it('reconciles scalar operation state without mutating Redis accounting state', async () => {
    const store = new RedisUsageStore(client);
    const req = request('reconcile-op');
    const input = {
      request: req,
      units: 1,
      budgets: [{ key: 'month:user-1:2026-08', limit: 2 }],
    };

    expect(await store.reconcileOperation(input)).toMatchObject({ status: 'absent' });
    const reserved = await store.reserve({ ...input, ttlMs: 5_000 });
    expect(reserved.accepted).toBe(true);
    if (!reserved.accepted) return;

    expect(await store.reconcileOperation(input)).toMatchObject({
      status: 'active',
      state: 'pending',
    });
    await store.markLiable({ reservationId: reserved.reservation.id });
    expect(await store.reconcileOperation(input)).toMatchObject({
      status: 'active',
      state: 'liable',
    });
    await store.settle({
      reservationId: reserved.reservation.id,
      actualUnits: 1,
      outcome: 'completed',
    });
    expect(await store.reconcileOperation(input)).toMatchObject({
      status: 'settled',
      reservedUnits: 1,
      actualUnits: 1,
    });
  });

  it('rejects reconciliation when retained scalar quote shape does not match', async () => {
    const store = new RedisUsageStore(client);
    const req = request('reconcile-mismatch');
    const reserved = await store.reserve({
      request: req,
      units: 1,
      budgets: [{ key: 'month:user-1:2026-08', limit: 2 }],
      ttlMs: 5_000,
    });
    expect(reserved.accepted).toBe(true);

    await expect(
      store.reconcileOperation({
        request: req,
        units: 2,
        budgets: [{ key: 'month:user-1:2026-08', limit: 2 }],
      }),
    ).rejects.toThrow(/does not match retained reservation state/);
  });

  it('atomically protects an overlapping shared tenant budget across 100 users', async () => {
    const control = new UsageControl(new RedisUsageStore(client), multiPolicy(1));
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        control.reserve(request(`op-${index}`, `user-${index}`, { tenantId: 'tenant-a' })),
      ),
    );
    expect(results.filter(result => result.allowed)).toHaveLength(1);
    const denied = results.filter(result => !result.allowed);
    expect(denied).toHaveLength(99);
    expect(denied.every(result => !result.allowed && result.limitingBudgetKey === 'tenant:tenant-a:monthly')).toBe(true);
  });

  it('does not leave a partial reservation when one of several budgets denies', async () => {
    const store = new RedisUsageStore(client);
    const deniedControl = new UsageControl(store, {
      quote() {
        return {
          decision: 'allow', units: 1,
          budgets: [{ key: 'a:user-budget', limit: 1 }, { key: 'b:tenant-budget', limit: 0 }],
        };
      },
    });
    expect(await deniedControl.reserve(request('denied'))).toEqual({
      allowed: false, reason: 'quota_exceeded', limitingBudgetKey: 'b:tenant-budget', remaining: 0,
    });

    const userOnly = new UsageControl(store, {
      quote() { return { decision: 'allow', units: 1, budgets: [{ key: 'a:user-budget', limit: 1 }] }; },
    });
    expect((await userOnly.reserve(request('after-denial'))).allowed).toBe(true);
  });

  it('rejects a duplicate operation ID within the full identity scope', async () => {
    const zeroPolicy: UsagePolicy = {
      quote() { return { decision: 'allow', units: 0, budgets: [{ key: 'shared', limit: 10 }] }; },
    };
    const control = new UsageControl(new RedisUsageStore(client), zeroPolicy);
    expect((await control.reserve(request('same-op', 'user-1', { tenantId: 't1', tool: 'read' }))).allowed).toBe(true);
    expect(await control.reserve(request('same-op', 'user-1', { tenantId: 't1', tool: 'read' }))).toEqual({ allowed: false, reason: 'duplicate_operation' });
    expect((await control.reserve(request('same-op', 'user-1', { tenantId: 't2', tool: 'read' }))).allowed).toBe(true);
    expect((await control.reserve(request('same-op', 'user-1', { tenantId: 't1', tool: 'write' }))).allowed).toBe(true);
  });

  it('releases unused units from every budget during settlement', async () => {
    const control = new UsageControl(new RedisUsageStore(client), multiPolicy(1));
    const first = await control.reserve(request('op-a', 'user-1', { tenantId: 'tenant-a' }));
    if (!first.allowed) throw new Error('expected admission');
    await first.lease.settle(0, 'pre_execution_failure');
    expect((await control.reserve(request('op-b', 'user-2', { tenantId: 'tenant-a' }))).allowed).toBe(true);
  });

  it('makes identical settlement replay idempotent and rejects conflicts', async () => {
    const control = new UsageControl(new RedisUsageStore(client), policy(2));
    const admission = await control.reserve(request('op-a'));
    if (!admission.allowed) throw new Error('expected admission');
    const first = await admission.lease.settle(1, 'success');
    expect(await admission.lease.settle(1, 'success')).toEqual(first);
    await expect(admission.lease.settle(0, 'success')).rejects.toThrow('already settled with a different result');
  });

  it('keeps settlement idempotent when Redis applied the write but its acknowledgement was lost', async () => {
    const lossyClient = new LoseNextReplyClient(client);
    const control = new UsageControl(new RedisUsageStore(lossyClient), policy(2));
    const admission = await control.reserve(request('op-a'));
    if (!admission.allowed) throw new Error('expected admission');
    lossyClient.loseNextReply = true;
    await expect(admission.lease.settle(1, 'success')).rejects.toThrow('simulated lost Redis acknowledgement');
    expect(await admission.lease.settle(1, 'success')).toEqual({
      reservationId: admission.lease.reservation.id, reservedUnits: 1, actualUnits: 1, releasedUnits: 0, outcome: 'success',
    });
  });

  it('replays a committed growth after its Redis acknowledgement is lost', async () => {
    const lossyClient = new LoseNextReplyClient(client);
    const control = new UsageControl(new RedisUsageStore(lossyClient), policy(3));
    const admission = await control.reserve(request('growth-lost-ack'));
    if (!admission.allowed) throw new Error('expected admission');
    const budgets = [{ key: 'month:user-1:2026-08', limit: 3 }] as const;
    const attempt = { incrementId: 'stable-growth-increment', additionalUnits: 1, budgets };

    lossyClient.loseNextReply = true;
    await expect(admission.lease.grow(attempt)).rejects.toThrow('simulated lost Redis acknowledgement');
    await expect(
      admission.lease.grow({ ...attempt, incrementId: 'fresh-growth-increment' }),
    ).rejects.toThrow(/unresolved/i);

    const replay = await admission.lease.grow(attempt);
    expect(replay).toMatchObject({ accepted: true, replayed: true, reservedUnits: 2 });
    expect(admission.lease.reservedUnits).toBe(2);
  });

  it('replays a committed vector growth after its Redis acknowledgement is lost', async () => {
    const lossyClient = new LoseNextReplyClient(client);
    const control = new VectorUsageControl(new RedisUsageStore(lossyClient), vectorPolicy());
    const admission = await control.reserve(request('vector-growth-lost-ack'));
    if (!admission.allowed) throw new Error('expected vector admission');
    const attempt = {
      incrementId: 'stable-vector-growth-increment',
      dimensions: [
        {
          key: 'requests',
          additionalUnits: 0,
          budgets: [{ key: 'vector:requests', limit: 2 }],
        },
        {
          key: 'tokens',
          additionalUnits: 3,
          budgets: [{ key: 'vector:tokens', limit: 20 }],
        },
      ],
    } as const;

    lossyClient.loseNextReply = true;
    await expect(admission.lease.grow(attempt)).rejects.toThrow(
      'simulated lost Redis acknowledgement',
    );
    await expect(
      admission.lease.grow({ ...attempt, incrementId: 'fresh-vector-growth-increment' }),
    ).rejects.toThrow(/unresolved/i);

    const replay = await admission.lease.grow(attempt);
    expect(replay).toMatchObject({ accepted: true, replayed: true });
    expect(admission.lease.reservedByDimension).toEqual([
      { key: 'requests', reservedUnits: 1 },
      { key: 'tokens', reservedUnits: 8 },
    ]);
  });

  it('fails closed after an admission write whose acknowledgement was lost', async () => {
    const lossyClient = new LoseNextReplyClient(client);
    const control = new UsageControl(new RedisUsageStore(lossyClient), policy(1));
    lossyClient.loseNextReply = true;
    await expect(control.reserve(request('op-a'))).rejects.toThrow('simulated lost Redis acknowledgement');
    expect(await control.reserve(request('op-a'))).toEqual({ allowed: false, reason: 'duplicate_operation' });
    expect(await control.reserve(request('op-b'))).toEqual({
      allowed: false, reason: 'quota_exceeded', limitingBudgetKey: 'month:user-1:2026-08', remaining: 0,
    });
  });

  it('saturates large recovery telemetry without making the triggering reserve ambiguous', async () => {
    const events: UsageEvent[] = [];
    const store = new RedisUsageStore(client, {
      cleanupBatchSize: 8,
      observer: { onEvent(event) { events.push(event); } },
    });
    const hugeUnits = 5_000_000_000_000_000;

    for (let index = 0; index < 2; index += 1) {
      const seeded = await store.reserve({
        request: request(`huge-expired-${index}`),
        units: hugeUnits,
        budgets: [{ key: `huge-budget-${index}`, limit: hugeUnits }],
        ttlMs: 40,
      });
      expect(seeded.accepted).toBe(true);
    }

    await sleep(80);
    const triggerInput = {
      request: request('huge-recovery-trigger'),
      units: 0,
      budgets: [{ key: 'huge-recovery-trigger-budget', limit: 1 }],
      ttlMs: 5_000,
    } as const;
    const trigger = await store.reserve(triggerInput);
    expect(trigger.accepted).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'reservation.recovered',
        store: 'redis',
        recovery: 'pending_released',
        count: 2,
        reservedUnits: Number.MAX_SAFE_INTEGER,
      }),
    );

    await expect(store.reserve(triggerInput)).resolves.toEqual({
      accepted: false,
      reason: 'duplicate_operation',
    });
  });

  it('reclaims an abandoned pending reservation from every budget after lease expiry', async () => {
    const control = new UsageControl(new RedisUsageStore(client), multiPolicy(1, 40));
    expect((await control.reserve(request('op-a', 'user-1', { tenantId: 'tenant-a' }))).allowed).toBe(true);
    await sleep(80);
    expect((await control.reserve(request('op-b', 'user-2', { tenantId: 'tenant-a' }))).allowed).toBe(true);
  });

  it('charges every budget when a cost-liable reservation expires before settlement', async () => {
    const control = new UsageControl(new RedisUsageStore(client), multiPolicy(1, 40));
    const first = await control.reserve(request('op-a', 'user-1', { tenantId: 'tenant-a' }));
    if (!first.allowed) throw new Error('expected admission');
    await first.lease.markLiable();
    await sleep(80);
    expect(await control.reserve(request('op-b', 'user-2', { tenantId: 'tenant-a' }))).toEqual({
      allowed: false, reason: 'quota_exceeded', limitingBudgetKey: 'tenant:tenant-a:monthly', remaining: 0,
    });
    expect(await control.reserve(request('op-a', 'user-1', { tenantId: 'tenant-a' }))).toEqual({ allowed: false, reason: 'duplicate_operation' });
  });

  it('fails safely if mark-liable was applied but its acknowledgement was lost', async () => {
    const lossyClient = new LoseNextReplyClient(client);
    const control = new UsageControl(new RedisUsageStore(lossyClient), policy(1, 40));
    const first = await control.reserve(request('op-a'));
    if (!first.allowed) throw new Error('expected admission');
    lossyClient.loseNextReply = true;
    await expect(first.lease.markLiable()).rejects.toThrow('simulated lost Redis acknowledgement');
    await sleep(80);
    expect(await control.reserve(request('op-b'))).toEqual({
      allowed: false, reason: 'quota_exceeded', limitingBudgetKey: 'month:user-1:2026-08', remaining: 0,
    });
  });

  it('rejects unsafe Redis lease expiry before creating scalar or vector state', async () => {
    const store = new RedisUsageStore(client);
    await expect(
      store.reserve({
        request: request('unsafe-time-scalar'),
        units: 1,
        budgets: [{ key: 'unsafe-time-scalar-budget', limit: 1 }],
        ttlMs: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow(/timestamp arithmetic exceeds safe integer range/);
    await expect(
      store.reserve({
        request: request('unsafe-time-scalar'),
        units: 1,
        budgets: [{ key: 'unsafe-time-scalar-budget', limit: 1 }],
        ttlMs: 1_000,
      }),
    ).resolves.toMatchObject({ accepted: true });

    await expect(
      store.reserveVector({
        request: request('unsafe-time-vector'),
        dimensions: [
          { key: 'requests', units: 1, budgets: [{ key: 'unsafe-time-vector-budget', limit: 1 }] },
        ],
        ttlMs: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow(/timestamp arithmetic exceeds safe integer range/);
    await expect(
      store.reserveVector({
        request: request('unsafe-time-vector'),
        dimensions: [
          { key: 'requests', units: 1, budgets: [{ key: 'unsafe-time-vector-budget', limit: 1 }] },
        ],
        ttlMs: 1_000,
      }),
    ).resolves.toMatchObject({ accepted: true });
  });

  it('rejects unsafe Redis renewal and settlement arithmetic before mutation', async () => {
    const normal = new RedisUsageStore(client);
    const reserved = await normal.reserve({
      request: request('unsafe-time-active'),
      units: 1,
      budgets: [{ key: 'unsafe-time-active-budget', limit: 1 }],
      ttlMs: 5_000,
    });
    if (!reserved.accepted) throw new Error('expected reservation');

    await expect(
      normal.renew({ reservationId: reserved.reservation.id, ttlMs: Number.MAX_SAFE_INTEGER }),
    ).rejects.toThrow(/timestamp arithmetic exceeds safe integer range/);

    const unsafeTombstones = new RedisUsageStore(client, {
      idempotencyTtlMs: Number.MAX_SAFE_INTEGER,
    });
    await expect(
      unsafeTombstones.settle({
        reservationId: reserved.reservation.id,
        actualUnits: 0,
        outcome: 'must-not-release',
      }),
    ).rejects.toThrow(/timestamp arithmetic exceeds safe integer range/);

    await expect(
      normal.reserve({
        request: request('unsafe-time-probe'),
        units: 1,
        budgets: [{ key: 'unsafe-time-active-budget', limit: 1 }],
        ttlMs: 1_000,
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'quota_exceeded' });
  });

  it('rejects unsafe Redis cleanup tombstones before recovering a liable lease', async () => {
    const normal = new RedisUsageStore(client);
    const reserved = await normal.reserve({
      request: request('unsafe-time-liable'),
      units: 1,
      budgets: [{ key: 'unsafe-time-liable-budget', limit: 1 }],
      ttlMs: 40,
    });
    if (!reserved.accepted) throw new Error('expected reservation');
    await normal.markLiable({ reservationId: reserved.reservation.id });
    await sleep(80);

    const unsafeTombstones = new RedisUsageStore(client, {
      idempotencyTtlMs: Number.MAX_SAFE_INTEGER,
    });
    await expect(
      unsafeTombstones.reserve({
        request: request('unsafe-time-cleanup-trigger'),
        units: 0,
        budgets: [{ key: 'unsafe-time-cleanup-trigger-budget', limit: 1 }],
        ttlMs: 1_000,
      }),
    ).rejects.toThrow(/timestamp arithmetic exceeds safe integer range/);

    // A normal store can still perform the authoritative liable recovery. If the
    // rejected call had partially recovered/refunded state, this probe would pass.
    await expect(
      normal.reserve({
        request: request('unsafe-time-liable-probe'),
        units: 1,
        budgets: [{ key: 'unsafe-time-liable-budget', limit: 1 }],
        ttlMs: 1_000,
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'quota_exceeded' });
  });

  it('does not use the application clock for Redis lease expiry calculations', async () => {
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('application clock must not be used by RedisUsageStore'); });
    const store = new RedisUsageStore(client);
    const result = await store.reserve({
      request: request('op-a'),
      units: 1,
      budgets: [{ key: 'month:user-1:2026-08', limit: 1 }],
      ttlMs: 200,
    });
    expect(result.accepted).toBe(true);
    expect(dateNow).not.toHaveBeenCalled();
  });

  it('does not reclaim a reservation whose lease was renewed', async () => {
    const control = new UsageControl(new RedisUsageStore(client), policy(1, 50));
    const first = await control.reserve(request('op-a'));
    if (!first.allowed) throw new Error('expected admission');
    await sleep(30);
    await first.lease.renew(120);
    await sleep(50);
    expect(await control.reserve(request('op-b'))).toEqual({
      allowed: false, reason: 'quota_exceeded', limitingBudgetKey: 'month:user-1:2026-08', remaining: 0,
    });
  });

  it('expires settled idempotency tombstones after configured retention', async () => {
    const zeroPolicy: UsagePolicy = {
      quote() { return { decision: 'allow', units: 0, budgets: [{ key: 'shared', limit: 1 }] }; },
    };
    const control = new UsageControl(new RedisUsageStore(client, { idempotencyTtlMs: 40 }), zeroPolicy);
    const first = await control.reserve(request('reusable-op'));
    if (!first.allowed) throw new Error('expected admission');
    await first.lease.settle(0, 'success');
    expect(await control.reserve(request('reusable-op'))).toEqual({ allowed: false, reason: 'duplicate_operation' });
    await sleep(80);
    expect((await control.reserve(request('reusable-op'))).allowed).toBe(true);
  });
});

describe('RedisUsageStore runtime input boundary', () => {
  it('rejects malformed request identity before Redis eval', async () => {
    let calls = 0;
    const store = new RedisUsageStore({ async eval() { calls += 1; return []; } });
    const malformed = { ...request('runtime-invalid'), tool: 42 } as never;
    await expect(
      store.reserve({ request: malformed, units: 1, budgets: [{ key: 'b', limit: 1 }], ttlMs: 1_000 }),
    ).rejects.toThrow(/tool must be a non-empty string/);
    expect(calls).toBe(0);
  });

  it('rejects non-string vector and actual dimension keys before Redis eval', async () => {
    let calls = 0;
    const store = new RedisUsageStore({ async eval() { calls += 1; return []; } });
    await expect(
      store.reserveVector({
        request: request('runtime-vector'),
        dimensions: [{ key: 7, units: 1, budgets: [{ key: 'b', limit: 1 }] }],
        ttlMs: 1_000,
      } as never),
    ).rejects.toThrow(/dimension.key must be a non-empty string/);
    await expect(
      store.settleVector({
        reservationId: `r2.${'a'.repeat(64)}`,
        actualByDimension: [{ key: 7, actualUnits: 0 }],
        outcome: 'done',
      } as never),
    ).rejects.toThrow(/actual dimension key must be a non-empty string/);
    expect(calls).toBe(0);
  });
});

describe('RedisUsageStore failure behavior', () => {
  it('fails closed when Redis admission is unavailable', async () => {
    const store = new RedisUsageStore({ async eval() { throw new Error('Redis unavailable'); } });
    await expect(new UsageControl(store, policy(1)).reserve(request('op-a'))).rejects.toThrow('Redis unavailable');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
