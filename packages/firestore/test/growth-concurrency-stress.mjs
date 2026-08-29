import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { FirestoreUsageStore } from '../dist/index.js';

const projectId = process.env.GCLOUD_PROJECT ?? 'demo-muc-firestore';
assert.ok(
  process.env.FIRESTORE_EMULATOR_HOST,
  'FIRESTORE_EMULATOR_HOST must be set; this test must never target production Firestore',
);

const database = new Firestore({ projectId });
const iterations = 24;

function request(operationId) {
  return {
    operationId,
    principal: { id: 'user-a', tenantId: 'tenant-a', plan: 'free' },
    tool: 'search',
    args: {},
  };
}

function storeFor(index) {
  const suffix = randomUUID().replaceAll('-', '');
  return new FirestoreUsageStore(database, {
    collectionPrefix: `muc_growth_stress_${index}_${suffix}`,
    cleanupBatchSize: 0,
    expiryGraceMs: 0,
    idempotencyTtlMs: 60_000,
  });
}

function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const code = 'code' in error ? ` code=${String(error.code)}` : '';
  return `${error.name}${code}: ${error.message}`;
}

function assertUsageStateRejection(result, label) {
  assert.equal(result.status, 'rejected', `${label} must reject`);
  assert.equal(
    result.reason?.name,
    'UsageStateError',
    `${label} must reject with UsageStateError, got ${describeError(result.reason)}`,
  );
}

try {
  for (let index = 0; index < iterations; index += 1) {
    const store = storeFor(index);

    const sameBudget = `growth:stress:same:${index}`;
    const same = await store.reserve({
      request: request(`growth-stress-same-${index}`),
      units: 1,
      budgets: [{ key: sameBudget, limit: 2 }],
      ttlMs: 60_000,
    });
    assert.equal(same.accepted, true, `same admission ${index} must succeed`);
    if (!same.accepted) throw new Error(`same admission ${index} failed`);
    const sameCursor = same.reservation.growthCursor;
    assert.equal(typeof sameCursor, 'string', `same admission ${index} must expose cursor`);

    const sameInput = {
      reservationId: same.reservation.id,
      incrementId: `same-inc-${index}`,
      expectedGrowthCursor: sameCursor,
      additionalUnits: 1,
      budgets: [{ key: sameBudget, limit: 2 }],
    };
    const sameResults = await Promise.allSettled([
      store.growReservation(sameInput),
      store.growReservation(sameInput),
    ]);
    for (const [attempt, result] of sameResults.entries()) {
      assert.equal(
        result.status,
        'fulfilled',
        `same increment ${index}/${attempt} failed: ${
          result.status === 'rejected' ? describeError(result.reason) : ''
        }`,
      );
    }
    const sameValues = sameResults.map(result => result.value);
    assert.equal(
      sameValues.filter(result => result.accepted && result.replayed).length,
      1,
      `same increment ${index} must replay exactly once`,
    );
    assert.equal(
      sameValues.filter(result => result.accepted && !result.replayed).length,
      1,
      `same increment ${index} must commit exactly once`,
    );

    const distinctBudget = `growth:stress:distinct:${index}`;
    const distinct = await store.reserve({
      request: request(`growth-stress-distinct-${index}`),
      units: 1,
      budgets: [{ key: distinctBudget, limit: 3 }],
      ttlMs: 60_000,
    });
    assert.equal(distinct.accepted, true, `distinct admission ${index} must succeed`);
    if (!distinct.accepted) throw new Error(`distinct admission ${index} failed`);
    const cursor = distinct.reservation.growthCursor;
    assert.equal(typeof cursor, 'string', `distinct admission ${index} must expose cursor`);

    const distinctResults = await Promise.allSettled([
      store.growReservation({
        reservationId: distinct.reservation.id,
        incrementId: `inc-a-${index}`,
        expectedGrowthCursor: cursor,
        additionalUnits: 1,
        budgets: [{ key: distinctBudget, limit: 3 }],
      }),
      store.growReservation({
        reservationId: distinct.reservation.id,
        incrementId: `inc-b-${index}`,
        expectedGrowthCursor: cursor,
        additionalUnits: 1,
        budgets: [{ key: distinctBudget, limit: 3 }],
      }),
    ]);
    const winnerCount = distinctResults.filter(result => result.status === 'fulfilled').length;
    const loserCount = distinctResults.filter(result => result.status === 'rejected').length;
    assert.equal(winnerCount, 1, `distinct increments ${index} must have exactly one winner`);
    assert.equal(loserCount, 1, `distinct increments ${index} must have exactly one loser`);
    const loser = distinctResults.find(result => result.status === 'rejected');
    assertUsageStateRejection(loser, `distinct stale cursor ${index}`);

    console.log(`ok - scalar growth concurrency stress ${index + 1}/${iterations}`);
  }

  console.log(`Firestore scalar growth concurrency stress passed ${iterations} iterations`);
} finally {
  await database.terminate();
}
