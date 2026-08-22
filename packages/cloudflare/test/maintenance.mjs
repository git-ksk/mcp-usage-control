import assert from 'node:assert/strict';
import {
  CloudflareUsageTransportError,
  RemoteCloudflareUsageStore,
} from '../dist/index.js';
import { pruneRemoteCloudflareHistoricalBudgets } from '../dist/maintenance.js';

const usageEndpoint =
  process.env.MCP_USAGE_CLOUDFLARE_URL ?? 'http://127.0.0.1:8799/v1/usage-store';
const maintenanceEndpoint =
  process.env.MCP_USAGE_CLOUDFLARE_MAINTENANCE_URL ??
  new URL('/v1/usage-store-maintenance', usageEndpoint).toString();
const token = process.env.MCP_USAGE_CLOUDFLARE_TOKEN ?? 'local-integration-token';
const authHeaders = { authorization: `Bearer ${token}` };
const store = new RemoteCloudflareUsageStore({ endpoint: usageEndpoint, headers: authHeaders });
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const makeRequest = operationId => ({
  operationId: `${nonce}-${operationId}`,
  principal: { id: 'maintenance-user', tenantId: 'maintenance-tenant', plan: 'free' },
  tool: 'maintenance-integration-tool',
  args: {},
});

async function consume(operationId, budgetKey) {
  const result = await store.reserve({
    request: makeRequest(operationId),
    units: 1,
    budgets: [{ key: budgetKey, limit: 1 }],
    ttlMs: 10_000,
  });
  assert.equal(result.accepted, true);
  if (!result.accepted) throw new Error('expected seed reservation');
  await store.markLiable({ reservationId: result.reservation.id });
  await store.settle({ reservationId: result.reservation.id, actualUnits: 1, outcome: 'seed' });
}

async function reserveVector(operationId, dimensions, ttlMs = 10_000) {
  const result = await store.reserveVector({
    request: makeRequest(operationId),
    dimensions,
    ttlMs,
  });
  assert.equal(result.accepted, true);
  if (!result.accepted) throw new Error(`expected vector seed reservation: ${operationId}`);
  return result;
}

const historicalKey = `${nonce}:daily:2026-07-01`;
const currentKey = `${nonce}:daily:2026-08-11`;
const activeKey = `${nonce}:active`;
const missingKey = `${nonce}:missing`;

await consume('historical-seed', historicalKey);
await consume('current-seed', currentKey);

const active = await store.reserve({
  request: makeRequest('active-seed'),
  units: 1,
  budgets: [{ key: activeKey, limit: 1 }],
  ttlMs: 10_000,
});
assert.equal(active.accepted, true);
if (!active.accepted) throw new Error('expected active seed reservation');

// Maintenance auth is fail-closed and independent from the usage result model.
await assert.rejects(
  () =>
    pruneRemoteCloudflareHistoricalBudgets(
      { endpoint: maintenanceEndpoint },
      { historicalBudgetKeys: [historicalKey], protectedCurrentBudgetKeys: [] },
    ),
  error => error instanceof CloudflareUsageTransportError && error.code === 'unauthorized',
);

const pruned = await pruneRemoteCloudflareHistoricalBudgets(
  { endpoint: maintenanceEndpoint, headers: authHeaders },
  {
    historicalBudgetKeys: [historicalKey, currentKey, activeKey, missingKey],
    protectedCurrentBudgetKeys: [currentKey],
  },
);
assert.deepEqual(pruned, {
  prunedKeys: [historicalKey],
  blockedProtectedKeys: [currentKey],
  blockedActiveKeys: [activeKey],
  missingKeys: [missingKey],
});

// The explicit historical row was reclaimed even though it had positive used units.
const historicalAfterPrune = await store.reserve({
  request: makeRequest('historical-after-prune'),
  units: 1,
  budgets: [{ key: historicalKey, limit: 1 }],
  ttlMs: 10_000,
});
assert.equal(historicalAfterPrune.accepted, true);
if (historicalAfterPrune.accepted) {
  await store.settle({
    reservationId: historicalAfterPrune.reservation.id,
    actualUnits: 0,
    outcome: 'cleanup',
  });
}

// A protected current window remains charged.
const currentAfterPrune = await store.reserve({
  request: makeRequest('current-after-prune'),
  units: 1,
  budgets: [{ key: currentKey, limit: 1 }],
  ttlMs: 10_000,
});
assert.deepEqual(currentAfterPrune, {
  accepted: false,
  reason: 'quota_exceeded',
  limitingBudgetKey: currentKey,
  remaining: 0,
});

// An active reservation budget cannot be deleted by maintenance.
const activeCompetitor = await store.reserve({
  request: makeRequest('active-competitor'),
  units: 1,
  budgets: [{ key: activeKey, limit: 1 }],
  ttlMs: 10_000,
});
assert.deepEqual(activeCompetitor, {
  accepted: false,
  reason: 'quota_exceeded',
  limitingBudgetKey: activeKey,
  remaining: 0,
});

// After the reservation is normally settled, a later explicit maintenance batch may prune it.
await store.settle({
  reservationId: active.reservation.id,
  actualUnits: 0,
  outcome: 'active-cleanup',
});
const activeAfterSettlement = await pruneRemoteCloudflareHistoricalBudgets(
  { endpoint: maintenanceEndpoint, headers: authHeaders },
  { historicalBudgetKeys: [activeKey], protectedCurrentBudgetKeys: [] },
);
assert.deepEqual(activeAfterSettlement, {
  prunedKeys: [activeKey],
  blockedProtectedKeys: [],
  blockedActiveKeys: [],
  missingKeys: [],
});

// Active vector reservations keep every referenced budget row protected, across
// multiple dimensions and multiple budgets within one dimension.
const vectorPendingPrimaryKey = `${nonce}:vector-pending-primary`;
const vectorPendingSiblingKey = `${nonce}:vector-pending-sibling`;
const vectorPendingOtherDimensionKey = `${nonce}:vector-pending-other-dimension`;
const vectorPending = await reserveVector('vector-pending', [
  {
    key: 'requests',
    units: 1,
    budgets: [
      { key: vectorPendingPrimaryKey, limit: 1 },
      { key: vectorPendingSiblingKey, limit: 1 },
    ],
  },
  {
    key: 'tokens',
    units: 2,
    budgets: [{ key: vectorPendingOtherDimensionKey, limit: 2 }],
  },
]);
const vectorPendingPrune = await pruneRemoteCloudflareHistoricalBudgets(
  { endpoint: maintenanceEndpoint, headers: authHeaders },
  {
    historicalBudgetKeys: [
      vectorPendingPrimaryKey,
      vectorPendingSiblingKey,
      vectorPendingOtherDimensionKey,
    ],
    protectedCurrentBudgetKeys: [],
  },
);
assert.deepEqual(vectorPendingPrune, {
  prunedKeys: [],
  blockedProtectedKeys: [],
  blockedActiveKeys: [
    vectorPendingPrimaryKey,
    vectorPendingSiblingKey,
    vectorPendingOtherDimensionKey,
  ],
  missingKeys: [],
});
const vectorPendingCompetitor = await store.reserveVector({
  request: makeRequest('vector-pending-competitor'),
  dimensions: [
    {
      key: 'requests',
      units: 1,
      budgets: [{ key: vectorPendingPrimaryKey, limit: 1 }],
    },
  ],
  ttlMs: 10_000,
});
assert.deepEqual(vectorPendingCompetitor, {
  accepted: false,
  reason: 'quota_exceeded',
  limitingDimensionKey: 'requests',
  limitingBudgetKey: vectorPendingPrimaryKey,
  remaining: 0,
});

// Exact JSON-path matching avoids treating a vector dimension ID as a budget
// reference merely because both identities use the same SHA-256 representation.
const vectorDimensionCollisionKey = `${nonce}:vector-dimension-collision`;
await consume('vector-dimension-collision-historical', vectorDimensionCollisionKey);
const vectorDimensionCollisionBudgetKey = `${nonce}:vector-dimension-collision-active-budget`;
const vectorDimensionCollision = await reserveVector('vector-dimension-collision-active', [
  {
    key: vectorDimensionCollisionKey,
    units: 1,
    budgets: [{ key: vectorDimensionCollisionBudgetKey, limit: 1 }],
  },
]);
const vectorDimensionCollisionPrune = await pruneRemoteCloudflareHistoricalBudgets(
  { endpoint: maintenanceEndpoint, headers: authHeaders },
  { historicalBudgetKeys: [vectorDimensionCollisionKey], protectedCurrentBudgetKeys: [] },
);
assert.deepEqual(vectorDimensionCollisionPrune, {
  prunedKeys: [vectorDimensionCollisionKey],
  blockedProtectedKeys: [],
  blockedActiveKeys: [],
  missingKeys: [],
});

// Liable vector reservations are equally active for maintenance purposes.
const vectorLiableKey = `${nonce}:vector-liable`;
const vectorLiable = await reserveVector('vector-liable', [
  {
    key: 'requests',
    units: 1,
    budgets: [{ key: vectorLiableKey, limit: 1 }],
  },
]);
await store.markLiable({ reservationId: vectorLiable.reservation.id });
const vectorLiablePrune = await pruneRemoteCloudflareHistoricalBudgets(
  { endpoint: maintenanceEndpoint, headers: authHeaders },
  { historicalBudgetKeys: [vectorLiableKey], protectedCurrentBudgetKeys: [] },
);
assert.deepEqual(vectorLiablePrune, {
  prunedKeys: [],
  blockedProtectedKeys: [],
  blockedActiveKeys: [vectorLiableKey],
  missingKeys: [],
});
const vectorLiableCompetitor = await store.reserveVector({
  request: makeRequest('vector-liable-competitor'),
  dimensions: [
    {
      key: 'requests',
      units: 1,
      budgets: [{ key: vectorLiableKey, limit: 1 }],
    },
  ],
  ttlMs: 10_000,
});
assert.deepEqual(vectorLiableCompetitor, {
  accepted: false,
  reason: 'quota_exceeded',
  limitingDimensionKey: 'requests',
  limitingBudgetKey: vectorLiableKey,
  remaining: 0,
});

// Lease expiry alone must not let maintenance bypass normal recovery. Pending
// and liable rows remain active accounting until a normal store operation
// performs recovery.
const expiredVectorPendingKey = `${nonce}:vector-expired-pending`;
await reserveVector(
  'vector-expired-pending',
  [{ key: 'requests', units: 1, budgets: [{ key: expiredVectorPendingKey, limit: 1 }] }],
  500,
);
const expiredVectorLiableKey = `${nonce}:vector-expired-liable`;
const expiredVectorLiable = await reserveVector(
  'vector-expired-liable',
  [{ key: 'requests', units: 1, budgets: [{ key: expiredVectorLiableKey, limit: 1 }] }],
  500,
);
await store.markLiable({ reservationId: expiredVectorLiable.reservation.id });
await sleep(650);
const expiredVectorPrune = await pruneRemoteCloudflareHistoricalBudgets(
  { endpoint: maintenanceEndpoint, headers: authHeaders },
  {
    historicalBudgetKeys: [expiredVectorPendingKey, expiredVectorLiableKey],
    protectedCurrentBudgetKeys: [],
  },
);
assert.deepEqual(expiredVectorPrune, {
  prunedKeys: [],
  blockedProtectedKeys: [],
  blockedActiveKeys: [expiredVectorPendingKey, expiredVectorLiableKey],
  missingKeys: [],
});

// A settled vector tombstone no longer blocks historical pruning after the
// configured 2s idempotency/retirement horizon has elapsed.
const settledVectorKey = `${nonce}:vector-settled`;
const settledVector = await reserveVector('vector-settled', [
  {
    key: 'requests',
    units: 1,
    budgets: [{ key: settledVectorKey, limit: 1 }],
  },
]);
await store.settleVector({
  reservationId: settledVector.reservation.id,
  actualByDimension: [{ key: 'requests', actualUnits: 0 }],
  outcome: 'retired',
});
await sleep(2_100);
const settledVectorPrune = await pruneRemoteCloudflareHistoricalBudgets(
  { endpoint: maintenanceEndpoint, headers: authHeaders },
  { historicalBudgetKeys: [settledVectorKey], protectedCurrentBudgetKeys: [] },
);
assert.deepEqual(settledVectorPrune, {
  prunedKeys: [settledVectorKey],
  blockedProtectedKeys: [],
  blockedActiveKeys: [],
  missingKeys: [],
});

// Clean up the still-active vector fixtures without relying on maintenance.
await store.settleVector({
  reservationId: vectorPending.reservation.id,
  actualByDimension: [
    { key: 'requests', actualUnits: 0 },
    { key: 'tokens', actualUnits: 0 },
  ],
  outcome: 'cleanup',
});
await store.settleVector({
  reservationId: vectorLiable.reservation.id,
  actualByDimension: [{ key: 'requests', actualUnits: 0 }],
  outcome: 'cleanup',
});
await store.settleVector({
  reservationId: vectorDimensionCollision.reservation.id,
  actualByDimension: [{ key: vectorDimensionCollisionKey, actualUnits: 0 }],
  outcome: 'cleanup',
});

console.log('cross-capability: scalar/vector active reservation maintenance protection: PASS');
console.log('Cloudflare historical budget maintenance integration: PASS');
