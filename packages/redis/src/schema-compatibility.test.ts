import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from 'redis';
import { RedisUsageStore } from './index.js';

const redisUrl = process.env.REDIS_URL;
const integration = redisUrl ? describe : describe.skip;
const client = createClient({ url: redisUrl ?? 'redis://127.0.0.1:6379' });

const reservationsKey = 'muc:{usage}:reservations';
const usedKey = 'muc:{usage}:used';

const request = (operationId: string) => ({
  operationId,
  principal: { id: 'schema-user', plan: 'free' },
  tool: 'schema-test',
  args: {},
});

const budget = (key: string, limit: number) => ({ key, limit });

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function readRecord(reservationId: string): Promise<Record<string, unknown>> {
  const raw = await client.hGet(reservationsKey, reservationId);
  if (!raw) throw new Error(`missing Redis reservation ${reservationId}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

async function writeRecord(
  reservationId: string,
  record: Record<string, unknown>,
): Promise<string> {
  const raw = JSON.stringify(record);
  await client.hSet(reservationsKey, reservationId, raw);
  return raw;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

integration('Redis persisted-state compatibility', () => {
  beforeAll(async () => {
    await client.connect();
  });

  beforeEach(async () => {
    await client.flushDb();
  });

  afterAll(async () => {
    await client.quit();
  });

  it('writes schemaVersion 1 for new scalar and vector reservations', async () => {
    const store = new RedisUsageStore(client);
    const scalar = await store.reserve({
      request: request('schema-new-scalar'),
      units: 1,
      budgets: [budget('schema:new:scalar', 2)],
      ttlMs: 5_000,
    });
    expect(scalar.accepted).toBe(true);
    if (!scalar.accepted) return;
    expect((await readRecord(scalar.reservation.id)).schemaVersion).toBe(1);

    const vector = await store.reserveVector({
      request: request('schema-new-vector'),
      dimensions: [
        {
          key: 'requests',
          units: 1,
          budgets: [budget('schema:new:vector:requests', 2)],
        },
        {
          key: 'cost',
          units: 5,
          budgets: [budget('schema:new:vector:cost', 10)],
        },
      ],
      ttlMs: 5_000,
    });
    expect(vector.accepted).toBe(true);
    if (!vector.accepted) return;
    expect((await readRecord(vector.reservation.id)).schemaVersion).toBe(1);
  });

  it('keeps exact pre-v1 unversioned reservations readable and settleable', async () => {
    const store = new RedisUsageStore(client);
    const input = {
      request: request('schema-legacy'),
      units: 1,
      budgets: [budget('schema:legacy', 2)],
      ttlMs: 5_000,
    } as const;
    const reserved = await store.reserve(input);
    expect(reserved.accepted).toBe(true);
    if (!reserved.accepted) return;

    const legacy = await readRecord(reserved.reservation.id);
    delete legacy.schemaVersion;
    await writeRecord(reserved.reservation.id, legacy);

    await expect(
      store.reconcileOperation({
        request: input.request,
        units: input.units,
        budgets: input.budgets,
      }),
    ).resolves.toMatchObject({ status: 'active', state: 'pending' });

    await expect(
      store.settle({
        reservationId: reserved.reservation.id,
        actualUnits: 1,
        outcome: 'completed',
      }),
    ).resolves.toMatchObject({ reservedUnits: 1, actualUnits: 1 });
  });

  it('fails closed on a future targeted record without mutating it or refunding quota', async () => {
    const store = new RedisUsageStore(client);
    const budgetKey = 'schema:future:target';
    const reserved = await store.reserve({
      request: request('schema-future-target'),
      units: 1,
      budgets: [budget(budgetKey, 1)],
      ttlMs: 5_000,
    });
    expect(reserved.accepted).toBe(true);
    if (!reserved.accepted) return;

    const future = await readRecord(reserved.reservation.id);
    future.schemaVersion = 2;
    const seededRaw = await writeRecord(reserved.reservation.id, future);

    await expect(
      store.settle({
        reservationId: reserved.reservation.id,
        actualUnits: 0,
        outcome: 'must-not-refund',
      }),
    ).rejects.toThrow(/unsupported_schema_version/);

    expect(await client.hGet(reservationsKey, reserved.reservation.id)).toBe(seededRaw);
    expect(await client.hGet(usedKey, digest(budgetKey))).toBe('1');

    await expect(
      store.reserve({
        request: request('schema-future-capacity-probe'),
        units: 1,
        budgets: [budget(budgetKey, 1)],
        ttlMs: 5_000,
      }),
    ).resolves.toMatchObject({ accepted: false, reason: 'quota_exceeded' });
  });

  it('preflights the full cleanup batch before any mutation when future state is present', async () => {
    const store = new RedisUsageStore(client);
    const budgetKey = 'schema:future:cleanup';
    const first = await store.reserve({
      request: request('schema-cleanup-first'),
      units: 1,
      budgets: [budget(budgetKey, 2)],
      ttlMs: 40,
    });
    const second = await store.reserve({
      request: request('schema-cleanup-future'),
      units: 1,
      budgets: [budget(budgetKey, 2)],
      ttlMs: 40,
    });
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    if (!first.accepted || !second.accepted) return;

    const future = await readRecord(second.reservation.id);
    future.schemaVersion = 2;
    const futureRaw = await writeRecord(second.reservation.id, future);
    const firstRaw = await client.hGet(reservationsKey, first.reservation.id);

    await sleep(80);

    await expect(
      store.reserve({
        request: request('schema-cleanup-trigger'),
        units: 0,
        budgets: [budget('schema:cleanup:trigger', 1)],
        ttlMs: 5_000,
      }),
    ).rejects.toThrow(/unsupported_schema_version/);

    expect(await client.hGet(usedKey, digest(budgetKey))).toBe('2');
    expect(await client.hGet(reservationsKey, first.reservation.id)).toBe(firstRaw);
    expect(await client.hGet(reservationsKey, second.reservation.id)).toBe(futureRaw);
  });
});
