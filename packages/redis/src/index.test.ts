import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { UsageControl, type UsagePolicy } from '@mcp-usage-control/core';
import { RedisUsageStore, type RedisEvalClient } from './index.js';

const redisUrl = process.env.REDIS_URL;
const integration = redisUrl ? describe : describe.skip;
const client = createClient({ url: redisUrl ?? 'redis://127.0.0.1:6379' });

const request = (operationId: string) => ({
  operationId,
  principal: { id: 'user-1', plan: 'free' },
  tool: 'search',
  args: {},
});

function policy(limit = 1, reservationTtlMs = 5_000): UsagePolicy {
  return {
    quote() {
      return {
        decision: 'allow',
        units: 1,
        budget: { key: 'month:user-1:2026-08', limit },
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
  beforeAll(async () => {
    await client.connect();
  });

  beforeEach(async () => {
    await client.flushDb();
  });

  afterAll(async () => {
    await client.quit();
  });

  it('admits exactly one of 100 concurrent calls when one unit remains', async () => {
    const control = new UsageControl(new RedisUsageStore(client), policy(1));
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) => control.reserve(request(`op-${index}`))),
    );

    expect(results.filter(result => result.allowed)).toHaveLength(1);
    expect(results.filter(result => !result.allowed && result.reason === 'quota_exceeded')).toHaveLength(99);
  });

  it('rejects a duplicate operation ID', async () => {
    const control = new UsageControl(new RedisUsageStore(client), policy(2));
    const first = await control.reserve(request('same-op'));
    expect(first.allowed).toBe(true);

    const duplicate = await control.reserve(request('same-op'));
    expect(duplicate).toEqual({ allowed: false, reason: 'duplicate_operation' });
  });

  it('releases unused units during settlement', async () => {
    const control = new UsageControl(new RedisUsageStore(client), policy(1));
    const first = await control.reserve(request('op-a'));
    if (!first.allowed) throw new Error('expected admission');

    await first.lease.settle(0, 'pre_execution_failure');
    const second = await control.reserve(request('op-b'));
    expect(second.allowed).toBe(true);
  });

  it('makes identical settlement replay idempotent and rejects conflicts', async () => {
    const control = new UsageControl(new RedisUsageStore(client), policy(2));
    const admission = await control.reserve(request('op-a'));
    if (!admission.allowed) throw new Error('expected admission');

    const first = await admission.lease.settle(1, 'success');
    const replay = await admission.lease.settle(1, 'success');
    expect(replay).toEqual(first);
    await expect(admission.lease.settle(0, 'success')).rejects.toThrow(
      'already settled with a different result',
    );
  });

  it('keeps settlement idempotent when Redis applied the write but its acknowledgement was lost', async () => {
    const lossyClient = new LoseNextReplyClient(client);
    const control = new UsageControl(new RedisUsageStore(lossyClient), policy(2));
    const admission = await control.reserve(request('op-a'));
    if (!admission.allowed) throw new Error('expected admission');

    lossyClient.loseNextReply = true;
    await expect(admission.lease.settle(1, 'success')).rejects.toThrow(
      'simulated lost Redis acknowledgement',
    );

    const replay = await admission.lease.settle(1, 'success');
    expect(replay).toEqual({
      reservationId: admission.lease.reservation.id,
      reservedUnits: 1,
      actualUnits: 1,
      releasedUnits: 0,
      outcome: 'success',
    });
  });

  it('fails closed after an admission write whose acknowledgement was lost', async () => {
    const lossyClient = new LoseNextReplyClient(client);
    const control = new UsageControl(new RedisUsageStore(lossyClient), policy(1));

    lossyClient.loseNextReply = true;
    await expect(control.reserve(request('op-a'))).rejects.toThrow(
      'simulated lost Redis acknowledgement',
    );

    const sameOperation = await control.reserve(request('op-a'));
    expect(sameOperation).toEqual({ allowed: false, reason: 'duplicate_operation' });

    const differentOperation = await control.reserve(request('op-b'));
    expect(differentOperation).toEqual({
      allowed: false,
      reason: 'quota_exceeded',
      remaining: 0,
    });
  });

  it('reclaims an abandoned reservation after its lease expires', async () => {
    const control = new UsageControl(new RedisUsageStore(client), policy(1, 40));
    const first = await control.reserve(request('op-a'));
    expect(first.allowed).toBe(true);

    await sleep(80);
    const second = await control.reserve(request('op-b'));
    expect(second.allowed).toBe(true);
  });

  it('does not reclaim a reservation whose lease was renewed', async () => {
    const control = new UsageControl(new RedisUsageStore(client), policy(1, 50));
    const first = await control.reserve(request('op-a'));
    if (!first.allowed) throw new Error('expected admission');

    await sleep(30);
    await first.lease.renew(120);
    await sleep(50);

    const second = await control.reserve(request('op-b'));
    expect(second).toEqual({ allowed: false, reason: 'quota_exceeded', remaining: 0 });
  });

  it('expires settled idempotency tombstones after the configured retention', async () => {
    const control = new UsageControl(
      new RedisUsageStore(client, { idempotencyTtlMs: 40 }),
      policy(2),
    );
    const first = await control.reserve(request('reusable-op'));
    if (!first.allowed) throw new Error('expected admission');
    await first.lease.settle(1, 'success');

    const immediate = await control.reserve(request('reusable-op'));
    expect(immediate).toEqual({ allowed: false, reason: 'duplicate_operation' });

    await sleep(80);
    const afterRetention = await control.reserve(request('reusable-op'));
    expect(afterRetention.allowed).toBe(true);
  });
});

describe('RedisUsageStore failure behavior', () => {
  it('fails closed when Redis admission is unavailable', async () => {
    const store = new RedisUsageStore({
      async eval() {
        throw new Error('Redis unavailable');
      },
    });
    const control = new UsageControl(store, policy(1));

    await expect(control.reserve(request('op-a'))).rejects.toThrow('Redis unavailable');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
