import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import {
  assertUsageStoreConformance,
  runOperationReconciliationStoreConformance,
  runVectorOperationReconciliationStoreConformance,
  runProgressiveUsageStoreConformance,
  runVectorUsageStoreConformance,
} from 'mcp-usage-control/conformance';
import { FirestoreUsageStore } from '../dist/index.js';
import { FirestoreMcpUsageFlowStore } from '../dist/mcp-flow.js';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';

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
      // The portable contract expects normal admission-time expiry recovery.
      // Most focused emulator cases disable background/lazy cleanup so they can
      // call recoverExpired() explicitly, but that would invalidate this suite.
      return storeFor(`contract_${scenario.replaceAll('-', '_')}`, {
        cleanupBatchSize: 16,
        cleanupIntervalMs: 0,
      });
    },
    async waitForLeaseExpiry(ttlMs) {
      await sleep(ttlMs + 120);
    },
    leaseTtlMs: 80,
    concurrency: 8,
  });

  assert.equal(report.passed, true, JSON.stringify(report.cases.filter(result => !result.passed)));
}

async function testReconciliationConformance() {
  const report = await runOperationReconciliationStoreConformance({
    createStore(scenario) {
      return storeFor(`reconcile_${scenario.replaceAll('-', '_')}`);
    },
    async waitForLeaseExpiry(ttlMs) {
      await sleep(ttlMs + 120);
    },
    leaseTtlMs: 80,
  });
  assert.equal(report.passed, true, JSON.stringify(report.cases.filter(result => !result.passed)));
}

async function testVectorReconciliationConformance() {
  const report = await runVectorOperationReconciliationStoreConformance({
    createStore(scenario) {
      return storeFor(`vector_reconcile_${scenario.replaceAll('-', '_')}`);
    },
    async waitForLeaseExpiry(ttlMs) {
      await sleep(ttlMs + 120);
    },
    leaseTtlMs: 80,
  });
  assert.equal(report.passed, true, JSON.stringify(report.cases.filter(result => !result.passed)));
}

async function testProgressiveConformance() {
  const report = await runProgressiveUsageStoreConformance({
    createStore(scenario) {
      return storeFor(`growth_${scenario.replaceAll('-', '_')}`, {
        cleanupBatchSize: 16,
        cleanupIntervalMs: 0,
      });
    },
    async waitForLeaseExpiry(ttlMs) {
      await sleep(ttlMs + 120);
    },
    leaseTtlMs: 80,
  });

  assert.equal(report.passed, true, JSON.stringify(report.cases.filter(result => !result.passed)));
}

async function testVectorConformance() {
  const report = await runVectorUsageStoreConformance({
    createStore(scenario) {
      return storeFor(`vector_${scenario.replaceAll('-', '_')}`, {
        cleanupBatchSize: 16,
        cleanupIntervalMs: 0,
      });
    },
    async waitForLeaseExpiry(ttlMs) {
      await sleep(ttlMs + 120);
    },
    leaseTtlMs: 80,
    concurrency: 8,
  });
  assert.equal(report.passed, true, JSON.stringify(report.cases.filter(result => !result.passed)));
}

async function testVectorGrowthSettleRaceStress() {
  const store = storeFor('vector_race_stress', { cleanupBatchSize: 0, expiryGraceMs: 0 });
  const iterations = 24;

  for (let index = 0; index < iterations; index += 1) {
    const suffix = `vector:race-stress:${index}`;
    const admission = await store.reserveVector({
      request: request(`vector-race-stress-${index}`),
      dimensions: [
        { key: 'requests', units: 1, budgets: [{ key: `${suffix}:requests`, limit: 2 }] },
        { key: 'tokens', units: 5, budgets: [{ key: `${suffix}:tokens`, limit: 10 }] },
      ],
      ttlMs: 60_000,
    });
    assert.equal(admission.accepted, true, `stress admission ${index} must succeed`);
    const cursor = admission.reservation.growthCursor;
    assert.equal(typeof cursor, 'string', `stress admission ${index} must expose a growth cursor`);

    const results = await Promise.allSettled([
      store.growVectorReservation({
        reservationId: admission.reservation.id,
        incrementId: `stress-growth-${index}`,
        expectedGrowthCursor: cursor,
        dimensions: [
          { key: 'requests', additionalUnits: 1, budgets: [{ key: `${suffix}:requests`, limit: 2 }] },
          { key: 'tokens', additionalUnits: 1, budgets: [{ key: `${suffix}:tokens`, limit: 10 }] },
        ],
      }),
      store.settleVector({
        reservationId: admission.reservation.id,
        actualByDimension: [
          { key: 'requests', actualUnits: 1 },
          { key: 'tokens', actualUnits: 5 },
        ],
        outcome: 'race-stress',
      }),
    ]);

    assert.equal(
      results[1].status,
      'fulfilled',
      `stress settlement ${index} must complete: ${results[1].status === 'rejected' ? String(results[1].reason) : ''}`,
    );
    if (results[0].status === 'fulfilled') {
      assert.equal(results[0].value.accepted, true, `stress growth ${index} must be accepted if it wins`);
      const requests = results[1].value.dimensions.find(item => item.key === 'requests');
      assert.equal(requests?.reservedUnits, 2, `stress settlement ${index} must observe committed growth`);
    }
  }
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

async function testRecoveredLiableReconciliation() {
  const store = storeFor('recovered_liable_reconcile');
  const req = request('recovered-liable-reconcile');
  const input = {
    request: req,
    units: 1,
    budgets: [{ key: 'reconcile:liable:budget', limit: 1 }],
  };

  const first = await store.reserve({ ...input, ttlMs: 80 });
  assert.equal(first.accepted, true);
  if (!first.accepted) throw new Error('expected liable reconciliation reservation');
  const originalLeaseExpiry = first.reservation.expiresAt;
  await store.markLiable({ reservationId: first.reservation.id });
  await sleep(200);

  assert.deepEqual(await store.reconcileOperation(input), {
    status: 'expired',
    state: 'liable',
    reservationId: first.reservation.id,
    expiredAt: originalLeaseExpiry,
  });

  const recovery = await store.recoverExpired(10);
  assert.equal(recovery.liableCount, 1);
  assert.equal(recovery.liableUnits, 1);

  const afterRecovery = await store.reconcileOperation(input);
  assert.deepEqual(afterRecovery, {
    status: 'expired',
    state: 'liable',
    reservationId: first.reservation.id,
    expiredAt: originalLeaseExpiry,
  });
  assert.deepEqual(
    await store.reconcileOperation(input),
    afterRecovery,
    'reconciliation after liable recovery must remain read-only',
  );

  const ordinaryInput = {
    request: request('ordinary-settlement-reconcile'),
    units: 1,
    budgets: [{ key: 'reconcile:ordinary:budget', limit: 2 }],
  };
  const ordinary = await store.reserve({ ...ordinaryInput, ttlMs: 60_000 });
  assert.equal(ordinary.accepted, true);
  if (!ordinary.accepted) throw new Error('expected ordinary reconciliation reservation');
  await store.settle({
    reservationId: ordinary.reservation.id,
    actualUnits: 1,
    outcome: 'completed',
  });
  assert.match(
    JSON.stringify(await store.reconcileOperation(ordinaryInput)),
    /"status":"settled"/,
    'ordinary explicit settlement must remain settled',
  );
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

async function testMcpFlowStore() {
  const prefix = randomUUID().replaceAll('-', '').slice(0, 12);
  const report = await assertMcpUsageFlowStoreConformance({
    createStore(scenario) {
      return new FirestoreMcpUsageFlowStore(database, {
        collectionPath: `muc_flow_${prefix}_${scenario.replaceAll('-', '_')}`,
      });
    },
    async waitForFlowExpiry(ttlMs) { await sleep(ttlMs + 150); },
    flowTtlMs: 1_500,
    concurrency: 16,
  });
  assert.ok(report.passed, JSON.stringify(report.cases.filter(x => !x.passed)));
}

async function testMcpFlowAckAndReplicaSafety() {
  const name = `muc_flow_ack_${randomUUID().replaceAll('-', '')}`;
  const a = new FirestoreMcpUsageFlowStore(database, { collectionPath: name });
  const b = new FirestoreMcpUsageFlowStore(database, { collectionPath: name });
  const expiresAt = Date.now() + 120_000;
  const record = {
    flowId: 'flow-ack-test-00000001',
    binding: { principalId: 'alice', tenantId: 'one', tool: 'search', argsHash: 'a'.repeat(64) },
    lease: {
      reservation: { id: 'reserve-1', operationId: 'operation-1', principalId: 'alice',
        tenantId: 'one', tool: 'search', budgetKeys: ['tenant:one'], reservedUnits: 2, expiresAt },
      ttlMs: 120_000,
    },
    round: 1,
    expiresAt,
  };
  await a.suspend(record);
  assert.equal(await b.consume(record.flowId, { ...record.binding, tenantId: 'other' }), undefined,
    'other tenant must not consume original record');
  const ackLoss = {
    collection(path) { return database.collection(path); },
    async runTransaction(fn) {
      await database.runTransaction(fn);
      throw new Error('simulated LOST ACK after committed transaction');
    },
  };
  const ambiguous = new FirestoreMcpUsageFlowStore(ackLoss, { collectionPath: name });
  await assert.rejects(() => ambiguous.consume(record.flowId, record.binding), /LOST ACK/);
  assert.equal(await a.consume(record.flowId, record.binding), undefined,
    'the committed consume must never execute a handler twice');

  const corrupt = { ...record, flowId: 'flow-corrupt-0000001' };
  await a.suspend(corrupt);
  await database.collection(name).doc(corrupt.flowId).update({ payload: '{broken' });
  await assert.rejects(() => b.consume(corrupt.flowId, corrupt.binding), /invalid/);
  assert.equal((await database.collection(name).doc(corrupt.flowId).get()).exists, true,
    'corrupt payload must never be deleted and consumed');
}

const tests = [
  ['portable UsageStore conformance', testPortableConformance],
  ['Firestore MCP flow (16 concurrent consumers)', testMcpFlowStore],
  ['Firestore MCP flow replica/lost-ACK/corruption', testMcpFlowAckAndReplicaSafety],
  ['operation reconciliation conformance', testReconciliationConformance],
  ['progressive UsageStore conformance', testProgressiveConformance],
  ['vector UsageStore conformance', testVectorConformance],
  ['vector growth-vs-settle race stress', testVectorGrowthSettleRaceStress],
  ['multi-budget atomicity', testMultiBudgetAtomicity],
  ['shared-budget concurrency', testSharedBudgetConcurrency],
  ['pending expiry recovery', testPendingExpiryRecovery],
  ['liable expiry retention', testLiableExpiryRetention],
  ['cross-capability: recovered liable reconciliation', testRecoveredLiableReconciliation],
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
