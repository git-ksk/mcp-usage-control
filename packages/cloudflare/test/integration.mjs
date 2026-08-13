import assert from 'node:assert/strict';
import {
  CloudflareUsageTransportError,
  RemoteCloudflareUsageStore,
} from '../dist/index.js';

const endpoint =
  process.env.MCP_USAGE_CLOUDFLARE_URL ?? 'http://127.0.0.1:8799/v1/usage-store';
const endpointUrl = new URL(endpoint);
const isLocalWorkerd =
  endpointUrl.protocol === 'http:' &&
  (endpointUrl.hostname === '127.0.0.1' || endpointUrl.hostname === 'localhost');
const token = process.env.MCP_USAGE_CLOUDFLARE_TOKEN ?? 'local-integration-token';
const oldToken = process.env.MCP_USAGE_CLOUDFLARE_OLD_TOKEN;
const authHeaders = { authorization: `Bearer ${token}` };
const store = new RemoteCloudflareUsageStore({ endpoint, headers: authHeaders });
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const makeRequest = (operationId, user = 'user-1') => ({
  operationId: `${nonce}-${operationId}`,
  principal: { id: user, tenantId: 'tenant-1', plan: 'free' },
  tool: 'integration-tool',
  args: { secret: 'must-never-cross-cloudflare-boundary' },
});

async function reserve(targetStore, operationId, budgetKey, limit, ttlMs = 2_000, units = 1) {
  return targetStore.reserve({
    request: makeRequest(operationId),
    units,
    budgets: [{ key: `${nonce}:${budgetKey}`, limit }],
    ttlMs,
  });
}

// Auth is fail-closed.
await assert.rejects(
  () => reserve(new RemoteCloudflareUsageStore({ endpoint }), 'unauthorized', 'auth', 1),
  error => error instanceof CloudflareUsageTransportError && error.code === 'unauthorized',
);

// Optional credential-rotation check for deployed dogfood: the previous token must be rejected.
if (oldToken) {
  const staleCredentialStore = new RemoteCloudflareUsageStore({
    endpoint,
    headers: { authorization: `Bearer ${oldToken}` },
  });
  await assert.rejects(
    () => reserve(staleCredentialStore, 'stale-credential', 'stale-credential', 1),
    error => error instanceof CloudflareUsageTransportError && error.code === 'unauthorized',
  );
}

// Local workerd fault injection exercises the real HTTP transport path for
// platform-style limit/unavailability responses. These are infrastructure
// failures, never business quota denials, and therefore must fail closed.
if (isLocalWorkerd) {
  for (const [pathname, operationId, expectedStatus] of [
    ['/test/platform-limit', 'platform-limit', 429],
    ['/test/platform-unavailable', 'platform-unavailable', 503],
  ]) {
    const failureStore = new RemoteCloudflareUsageStore({
      endpoint: new URL(pathname, endpointUrl.origin).toString(),
      headers: authHeaders,
    });
    await assert.rejects(
      () => reserve(failureStore, operationId, operationId, 1),
      error =>
        error instanceof CloudflareUsageTransportError &&
        error.code === 'remote' &&
        error.status === expectedStatus,
      `${pathname} must remain a fail-closed platform error with HTTP status metadata`,
    );
  }
}

// 100-way contention: one shared remaining unit admits exactly one caller.
const concurrent = await Promise.all(
  Array.from({ length: 100 }, (_, index) =>
    reserve(store, `parallel-${index}`, 'parallel-one', 1, 5_000),
  ),
);
const acceptedConcurrent = concurrent.filter(result => result.accepted);
assert.equal(acceptedConcurrent.length, 1, 'exactly one of 100 calls must reserve the final unit');

// Multi-budget denial is all-or-nothing: a denied shared budget must not consume the other budget.
const fillShared = await store.reserve({
  request: makeRequest('multibudget-fill'),
  units: 1,
  budgets: [{ key: `${nonce}:multibudget-shared`, limit: 1 }],
  ttlMs: 5_000,
});
assert.equal(fillShared.accepted, true);
const deniedMulti = await store.reserve({
  request: makeRequest('multibudget-denied'),
  units: 1,
  budgets: [
    { key: `${nonce}:multibudget-free`, limit: 1 },
    { key: `${nonce}:multibudget-shared`, limit: 1 },
  ],
  ttlMs: 5_000,
});
assert.equal(deniedMulti.accepted, false);
const freeBudgetStillAvailable = await store.reserve({
  request: makeRequest('multibudget-free-check'),
  units: 1,
  budgets: [{ key: `${nonce}:multibudget-free`, limit: 1 }],
  ttlMs: 5_000,
});
assert.equal(freeBudgetStillAvailable.accepted, true, 'denied multi-budget reserve must not partially consume another budget');

// Duplicate operation identity is blocked without a second reservation.
const firstDuplicate = await reserve(store, 'duplicate', 'duplicate-budget', 10);
assert.equal(firstDuplicate.accepted, true);
const secondDuplicate = await reserve(store, 'duplicate', 'duplicate-budget', 10);
assert.deepEqual(secondDuplicate, { accepted: false, reason: 'duplicate_operation' });
if (!firstDuplicate.accepted) throw new Error('expected duplicate fixture admission');
await store.settle({ reservationId: firstDuplicate.reservation.id, actualUnits: 1, outcome: 'success' });
const replayedSettlement = await store.settle({
  reservationId: firstDuplicate.reservation.id,
  actualUnits: 1,
  outcome: 'success',
});
assert.equal(replayedSettlement.actualUnits, 1, 'identical settlement replay must be idempotent');
await assert.rejects(
  () =>
    store.settle({
      reservationId: firstDuplicate.reservation.id,
      actualUnits: 0,
      outcome: 'different',
    }),
  /different result/,
);

// Expiry fixtures need enough headroom for remote HTTP/workerd round trips on slow CI runners.
const expiryFixtureTtlMs = 500;
const expiryFixtureWaitMs = 650;

// Pending expiry releases capacity on the next admission cleanup.
const recoveryEvents = [];
const observedStore = new RemoteCloudflareUsageStore({
  endpoint,
  headers: authHeaders,
  observer: { onEvent(event) { recoveryEvents.push(event); } },
});
const pending = await reserve(
  observedStore,
  'pending-expiry',
  'pending-expiry-budget',
  1,
  expiryFixtureTtlMs,
);
assert.equal(pending.accepted, true);
await sleep(expiryFixtureWaitMs);
const afterPending = await reserve(observedStore, 'pending-after-expiry', 'pending-expiry-budget', 1, 1_000);
assert.equal(afterPending.accepted, true, 'expired pending reservation must release capacity');
assert.ok(
  recoveryEvents.some(
    event =>
      event.type === 'reservation.recovered' &&
      event.store === 'cloudflare' &&
      event.recovery === 'pending_released',
  ),
  'pending recovery event must be observed',
);

// Cost-liable expiry retains the full reservation and emits recovery telemetry.
const liable = await reserve(
  observedStore,
  'liable-expiry',
  'liable-expiry-budget',
  1,
  expiryFixtureTtlMs,
);
assert.equal(liable.accepted, true);
if (!liable.accepted) throw new Error('expected liable fixture admission');
await observedStore.markLiable({ reservationId: liable.reservation.id });
await sleep(expiryFixtureWaitMs);
const afterLiable = await reserve(observedStore, 'liable-after-expiry', 'liable-expiry-budget', 1, 1_000);
assert.deepEqual(
  afterLiable,
  {
    accepted: false,
    reason: 'quota_exceeded',
    limitingBudgetKey: `${nonce}:liable-expiry-budget`,
    remaining: 0,
  },
  'expired liable reservation must retain the full charge',
);
assert.ok(
  recoveryEvents.some(
    event =>
      event.type === 'reservation.recovered' &&
      event.store === 'cloudflare' &&
      event.recovery === 'liable_retained',
  ),
  'liable recovery event must be observed',
);

// Long-running work survives beyond its initial lease through explicit renewal.
// Keep a wide margin after each renewal so slow CI/workerd requests cannot make this timing test flaky.
const longRunning = await reserve(store, 'long-running', 'long-running-budget', 1, 500);
assert.equal(longRunning.accepted, true);
if (!longRunning.accepted) throw new Error('expected long-running admission');
await store.markLiable({ reservationId: longRunning.reservation.id });
for (let index = 0; index < 8; index += 1) {
  await sleep(100);
  await store.renew({ reservationId: longRunning.reservation.id, ttlMs: 500 });
}
await sleep(100);
await store.settle({ reservationId: longRunning.reservation.id, actualUnits: 1, outcome: 'success' });

// Lost reserve ACK is not blindly retried. A manual retry sees the committed duplicate.
let loseNextReserveAck = true;
const lostReserveAckStore = new RemoteCloudflareUsageStore({
  endpoint,
  headers: authHeaders,
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (loseNextReserveAck) {
      loseNextReserveAck = false;
      await response.text();
      throw new Error('simulated lost reserve acknowledgement');
    }
    return response;
  },
});
await assert.rejects(
  () => reserve(lostReserveAckStore, 'lost-reserve-ack', 'lost-reserve-budget', 1, 500),
  error => error instanceof CloudflareUsageTransportError && error.code === 'network',
);
const reserveRetry = await reserve(store, 'lost-reserve-ack', 'lost-reserve-budget', 1, 500);
assert.deepEqual(reserveRetry, { accepted: false, reason: 'duplicate_operation' });
const competingAfterLostAck = await reserve(store, 'lost-reserve-competitor', 'lost-reserve-budget', 1, 500);
assert.equal(competingAfterLostAck.accepted, false, 'committed lost-ACK reserve must still consume capacity');

// Lost settlement ACK can be reconciled by replaying the identical settlement.
const settleFixture = await reserve(store, 'lost-settle-ack', 'lost-settle-budget', 1, 1_000);
assert.equal(settleFixture.accepted, true);
if (!settleFixture.accepted) throw new Error('expected settlement fixture admission');
let loseNextSettleAck = true;
const lostSettleAckStore = new RemoteCloudflareUsageStore({
  endpoint,
  headers: authHeaders,
  fetch: async (input, init) => {
    const parsed = JSON.parse(String(init?.body ?? '{}'));
    const response = await fetch(input, init);
    if (parsed.method === 'settle' && loseNextSettleAck) {
      loseNextSettleAck = false;
      await response.text();
      throw new Error('simulated lost settlement acknowledgement');
    }
    return response;
  },
});
await assert.rejects(
  () =>
    lostSettleAckStore.settle({
      reservationId: settleFixture.reservation.id,
      actualUnits: 1,
      outcome: 'success',
    }),
  error => error instanceof CloudflareUsageTransportError && error.code === 'network',
);
const reconciled = await store.settle({
  reservationId: settleFixture.reservation.id,
  actualUnits: 1,
  outcome: 'success',
});
assert.equal(reconciled.actualUnits, 1);

// Observer failure is isolated from enforcement.
const throwingObserverStore = new RemoteCloudflareUsageStore({
  endpoint,
  headers: authHeaders,
  observer: { onEvent() { throw new Error('telemetry backend unavailable'); } },
});
const observerFixture = await reserve(
  throwingObserverStore,
  'observer-failure',
  'observer-failure-budget',
  1,
  1_000,
);
assert.equal(observerFixture.accepted, true);

console.log(`Cloudflare Durable Objects integration: PASS (${endpoint})`);
