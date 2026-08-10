import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { UsageControl, type UsageEvent, type UsageObserver, type UsagePolicy } from 'mcp-usage-control';
import { RedisUsageStore } from './index.js';

const redisUrl = process.env.REDIS_URL;
const integration = redisUrl ? describe : describe.skip;
const client = createClient({ url: redisUrl ?? 'redis://127.0.0.1:6379', database: 15 });

const observerEvents: UsageEvent[] = [];
const observer: UsageObserver = { onEvent: event => observerEvents.push(event) };

const policy: UsagePolicy = {
  quote(req) {
    return {
      decision: 'allow',
      units: 1,
      budgets: [{ key: `shared:${req.principal.tenantId}`, limit: 1 }],
      reservationTtlMs: 40,
    };
  },
};

function request(operationId: string, principalId: string) {
  return {
    operationId,
    principal: { id: principalId, tenantId: 'tenant-obs', plan: 'free' },
    tool: 'search',
    args: { secret: 'not-observed' },
  };
}

integration('RedisUsageStore observability', () => {
  beforeAll(async () => { await client.connect(); });
  beforeEach(async () => { observerEvents.length = 0; await client.flushDb(); });
  afterAll(async () => { await client.quit(); });

  it('emits aggregate pending cleanup recovery without persisting raw request identity', async () => {
    const store = new RedisUsageStore(client, { prefix: 'obs', hashTag: 'pending', observer });
    const control = new UsageControl(store, policy, { observer });
    expect((await control.reserve(request('pending-a', 'user-a'))).allowed).toBe(true);
    await sleep(80);
    expect((await control.reserve(request('pending-b', 'user-b'))).allowed).toBe(true);

    expect(observerEvents).toContainEqual(expect.objectContaining({
      type: 'reservation.recovered',
      store: 'redis',
      recovery: 'pending_released',
      reservedUnits: 1,
      count: 1,
    }));
    const recovery = observerEvents.find(event => event.type === 'reservation.recovered');
    expect(recovery).not.toHaveProperty('principalId');
    expect(recovery).not.toHaveProperty('tenantId');
    expect(JSON.stringify(recovery)).not.toContain('user-a');
    expect(JSON.stringify(recovery)).not.toContain('tenant-obs');
  });

  it('emits aggregate liable retention recovery when cleanup is triggered by another reserve', async () => {
    const store = new RedisUsageStore(client, { prefix: 'obs', hashTag: 'liable', observer });
    const control = new UsageControl(store, policy, { observer });
    const first = await control.reserve(request('liable-a', 'user-a'));
    if (!first.allowed) throw new Error('expected admission');
    await first.lease.markLiable();
    await sleep(80);
    await control.reserve(request('liable-b', 'user-b'));

    expect(observerEvents).toContainEqual(expect.objectContaining({
      type: 'reservation.recovered',
      store: 'redis',
      recovery: 'liable_retained',
      reservedUnits: 1,
      count: 1,
    }));
  });

  it('emits an opaque per-reservation recovery when an expired lease is touched directly', async () => {
    const store = new RedisUsageStore(client, { prefix: 'obs', hashTag: 'direct', observer });
    const control = new UsageControl(store, policy, { observer });
    const first = await control.reserve(request('direct-a', 'user-a'));
    if (!first.allowed) throw new Error('expected admission');
    await sleep(80);
    await expect(first.lease.renew()).rejects.toThrow('expired');

    expect(observerEvents).toContainEqual(expect.objectContaining({
      type: 'reservation.recovered',
      store: 'redis',
      recovery: 'pending_released',
      reservationId: first.lease.reservation.id,
      reservedUnits: 1,
      count: 1,
    }));
    expect(observerEvents).toContainEqual(expect.objectContaining({
      type: 'operation.error',
      phase: 'renew',
      source: 'store',
      errorName: 'UsageStateError',
    }));
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
