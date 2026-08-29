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
// Keep the always-on emulator stress bounded; use higher counts manually before releases when needed.
const iterations = 12;

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

function isUsageStateRejection(result) {
  return result.status === 'rejected' && result.reason?.name === 'UsageStateError';
}

async function resolveSameIncrementResults(store, results, input, label) {
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const rejected = results.filter(result => result.status === 'rejected');

  if (rejected.length === 0) {
    const values = fulfilled.map(result => result.value);
    assert.equal(
      values.filter(result => result.accepted && result.replayed).length,
      1,
      `${label} must replay exactly once when both acknowledgements arrive`,
    );
    assert.equal(
      values.filter(result => result.accepted && !result.replayed).length,
      1,
      `${label} must commit exactly once when both acknowledgements arrive`,
    );
    return;
  }

  // At least one acknowledged result establishes that this logical increment has
  // an authoritative winner. A provider error on the identical concurrent call is
  // therefore resolved only by one exact replay of the same increment/cursor/input.
  assert.equal(fulfilled.length, 1, `${label} provider ambiguity requires one observed winner`);
  assert.equal(rejected.length, 1, `${label} provider ambiguity requires one unresolved call`);
  const unresolved = rejected[0];
  assert.notEqual(
    unresolved.reason?.name,
    'UsageStateError',
    `${label} identical increment must not reject authoritatively: ${describeError(unresolved.reason)}`,
  );

  const replay = await Promise.allSettled([store.growReservation(input)]).then(values => values[0]);
  assert.equal(
    replay.status,
    'fulfilled',
    `${label} exact replay failed after ${describeError(unresolved.reason)}: ${
      replay.status === 'rejected' ? describeError(replay.reason) : ''
    }`,
  );
  assert.equal(replay.value.accepted, true, `${label} exact replay must be accepted`);
  assert.equal(replay.value.replayed, true, `${label} exact replay must observe the committed increment`);
  assert.equal(replay.value.reservedUnits, 2, `${label} exact replay observed an invalid reserved total`);
  assert.equal(
    fulfilled[0].value.reservedUnits,
    2,
    `${label} acknowledged winner observed an invalid reserved total`,
  );
  console.log(
    `resolved - ${label} provider ambiguity via exact replay: ${describeError(unresolved.reason)}`,
  );
}

async function assertDistinctLoserResolves(store, result, input, label) {
  assert.equal(result.status, 'rejected', `${label} must reject`);
  if (isUsageStateRejection(result)) return;

  // A raw Firestore provider error is ambiguous and must never be treated as the
  // expected stale-cursor loser by itself. Re-attempt only the exact same logical
  // increment once. The growth cursor + increment idempotency fence makes this a
  // resolution probe, not a fresh billable/accounting operation or blanket retry.
  const replay = await Promise.allSettled([store.growReservation(input)]).then(values => values[0]);
  assert.equal(
    replay.status,
    'rejected',
    `${label} exact replay unexpectedly fulfilled after ${describeError(result.reason)}; ` +
      'the ambiguous loser may have committed alongside the observed winner',
  );
  assert.equal(
    replay.reason?.name,
    'UsageStateError',
    `${label} exact replay did not resolve authoritatively after ${describeError(result.reason)}; ` +
      `got ${describeError(replay.reason)}`,
  );
  console.log(
    `resolved - ${label} provider ambiguity via exact replay: ${describeError(result.reason)}`,
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
    await resolveSameIncrementResults(store, sameResults, sameInput, `same increment ${index}`);

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

    const distinctInputs = [
      {
        reservationId: distinct.reservation.id,
        incrementId: `inc-a-${index}`,
        expectedGrowthCursor: cursor,
        additionalUnits: 1,
        budgets: [{ key: distinctBudget, limit: 3 }],
      },
      {
        reservationId: distinct.reservation.id,
        incrementId: `inc-b-${index}`,
        expectedGrowthCursor: cursor,
        additionalUnits: 1,
        budgets: [{ key: distinctBudget, limit: 3 }],
      },
    ];
    const distinctResults = await Promise.allSettled(
      distinctInputs.map(input => store.growReservation(input)),
    );
    const winnerIndexes = distinctResults
      .map((result, attempt) => ({ result, attempt }))
      .filter(entry => entry.result.status === 'fulfilled')
      .map(entry => entry.attempt);
    const loserIndexes = distinctResults
      .map((result, attempt) => ({ result, attempt }))
      .filter(entry => entry.result.status === 'rejected')
      .map(entry => entry.attempt);
    assert.equal(winnerIndexes.length, 1, `distinct increments ${index} must have exactly one winner`);
    assert.equal(loserIndexes.length, 1, `distinct increments ${index} must have exactly one loser`);

    const loserIndex = loserIndexes[0];
    await assertDistinctLoserResolves(
      store,
      distinctResults[loserIndex],
      distinctInputs[loserIndex],
      `distinct stale cursor ${index}/${loserIndex}`,
    );

    console.log(`ok - scalar growth concurrency stress ${index + 1}/${iterations}`);
  }

  console.log(`Firestore scalar growth concurrency stress passed ${iterations} iterations`);
} finally {
  await database.terminate();
}
