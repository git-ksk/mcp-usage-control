import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { assertUsageStoreConformance } from 'mcp-usage-control/conformance';
import { FirestoreUsageStore } from '../dist/index.js';

const projectId = process.env.GCLOUD_PROJECT ?? 'demo-muc-firestore';
assert.ok(
  process.env.FIRESTORE_EMULATOR_HOST,
  'FIRESTORE_EMULATOR_HOST must be set; this test must never target production Firestore',
);

const database = new Firestore({ projectId });

function request(operationId, principalId = 'user-a') {
  return {
    operationId,
    principal: { id: principalId, tenantId: 'tenant-a', plan: 'free' },
    tool: 'search',
    args: {},
  };
}

function storeFor(name, options = {}) {
  const suffix = randomUUID().replaceAll('-', '');
  return new FirestoreUsageStore(database, {
    collectionPrefix: `muc_e2e_${name}_${suffix}`,
    cleanupBatchSize: 0,
    expiryGraceMs: 0,
    idempotencyTtlMs: 60_000,
    ...options,
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testPortableConformance() {
  const report = await assertUsageStoreConformance({
    createStore(scenario) {
      return storeFor(`contract_${scenario.replaceAll('-', '_')}`);
    },
    async waitForLeaseExpiry(ttlMs) {
      await sleep(ttlMs + 120);
    },
    leaseTtlMs: 80,
    concurrency: 8,
  });

  assert.equal(report.passed, true, JSON.stringify(report.cases.filter(result => !result.passed)));
}

async function testMultiBudgetAtomicity() {
  const store = storeFor('atomic');

  const denied = await store.reserve({
    request: request('atomic-denied'),
    units: 1,
    budgets: [
      { key: 'day:user-a', limit: 1 },
      { key: 'month:tenant-a', limit: 0 },
    ],
    ttlMs: 60_000,
  });

  assert.deepEqual(denied, {
    accepted: false,
    reason: 'quota_exceeded',
    limitingBudgetKey: 'month:tenant-a',
    remaining: 0,
  });

  const userOnly = await store.reserve({
    request: request('atomic-followup'),
    units: 1,
    budgets: [{ key: 'day:user-a', limit: 1 }],
    ttlMs: 60_000,
  });

  assert.equal(
    userOnly.accepted,
    true,
    'a denied multi-budget transaction must not partially consume the user budget',
  );
}

async function testSharedBudgetConcurrency() {
  const store = storeFor('concurrency');
  const concurrency = 8;
  const sharedLimit = 3;

  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, index) =>
      store.reserve({
        request: request(`parallel-${index}`, `user-${index}`),
        units: 1,
        budgets: [{ key: 'month:tenant-a', limit: sharedLimit }],
        ttlMs: 60_000,
      }),
    ),
  );

  assert.equal(
    results.filter(result => result.accepted).length,
    sharedLimit,
    'Firestore transaction retries must prevent shared-budget over-admission',
  );
  assert.equal(results.filter(result => !result.accepted).length, concurrency - sharedLimit);
}

async function testPendingExpiryRecovery() {
  const store = storeFor('pending');
  const operationId = 'pending-reuse';

  const first = await store.reserve({
    request: request(operationId),
    units: 1,
    budgets: [{ key: 'day:user-a', limit: 1 }],
    ttlMs: 80,
  });
  assert.equal(first.accepted, true);

  await sleep(200);
  const recovery = await store.recoverExpired(10);
  assert.equal(recovery.pendingCount, 1);
  assert.equal(recovery.pendingUnits, 1);

  const reused = await store.reserve({
    request: request(operationId),
    units: 1,
    budgets: [{ key: 'day:user-a', limit: 1 }],
    ttlMs: 60_000,
  });
  assert.equal(reused.accepted, true, 'expired pending capacity must be released transactionally');
}

async function testLiableExpiryRetention() {
  const store = storeFor('liable');

  const first = await store.reserve({
    request: request('liable-first'),
    units: 1,
    budgets: [{ key: 'day:user-a', limit: 1 }],
    ttlMs: 80,
  });
  assert.equal(first.accepted, true);
  if (!first.accepted) throw new Error('expected liable reservation');

  await store.markLiable({ reservationId: first.reservation.id });
  await sleep(200);

  const recovery = await store.recoverExpired(10);
  assert.equal(recovery.liableCount, 1);
  assert.equal(recovery.liableUnits, 1);

  const denied = await store.reserve({
    request: request('liable-second'),
    units: 1,
    budgets: [{ key: 'day:user-a', limit: 1 }],
    ttlMs: 60_000,
  });
  assert.deepEqual(denied, {
    accepted: false,
    reason: 'quota_exceeded',
    limitingBudgetKey: 'day:user-a',
    remaining: 0,
  });
}

async function testIdempotentSettlement() {
  const store = storeFor('settlement');

  const reservation = await store.reserve({
    request: request('settle-first'),
    units: 2,
    budgets: [{ key: 'day:user-a', limit: 2 }],
    ttlMs: 60_000,
  });
  assert.equal(reservation.accepted, true);
  if (!reservation.accepted) throw new Error('expected settlement reservation');

  const input = {
    reservationId: reservation.reservation.id,
    actualUnits: 1,
    outcome: 'success',
  };
  const settled = await store.settle(input);
  const replay = await store.settle(input);
  assert.deepEqual(replay, settled, 'same settlement must replay idempotently');

  const remaining = await store.reserve({
    request: request('settle-followup'),
    units: 1,
    budgets: [{ key: 'day:user-a', limit: 2 }],
    ttlMs: 60_000,
  });
  assert.equal(remaining.accepted, true, 'settlement must release unused reserved capacity');
}

const tests = [
  ['portable UsageStore conformance', testPortableConformance],
  ['multi-budget atomicity', testMultiBudgetAtomicity],
  ['shared-budget concurrency', testSharedBudgetConcurrency],
  ['pending expiry recovery', testPendingExpiryRecovery],
  ['liable expiry retention', testLiableExpiryRetention],
  ['idempotent settlement', testIdempotentSettlement],
];

try {
  for (const [name, test] of tests) {
    await test();
    console.log(`ok - ${name}`);
  }
  console.log(`Firestore emulator integration passed against ${process.env.FIRESTORE_EMULATOR_HOST}`);
} finally {
  await database.terminate();
}
