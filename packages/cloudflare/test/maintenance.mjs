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

console.log('Cloudflare historical budget maintenance integration: PASS');
