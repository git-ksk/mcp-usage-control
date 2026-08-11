import assert from 'node:assert/strict';
import { UsageControl } from 'mcp-usage-control';
import {
  CloudflareUsageTransportError,
  RemoteCloudflareUsageStore,
} from '../dist/index.js';
import { reconcileRemoteCloudflareReserve } from '../dist/reconciliation.js';

const endpoint =
  process.env.MCP_USAGE_CLOUDFLARE_URL ?? 'http://127.0.0.1:8799/v1/usage-store';
const token = process.env.MCP_USAGE_CLOUDFLARE_TOKEN ?? 'local-integration-token';
const authHeaders = { authorization: `Bearer ${token}` };
const store = new RemoteCloudflareUsageStore({ endpoint, headers: authHeaders });
const control = new UsageControl(store, {
  quote() {
    throw new Error('policy must not be re-run while resuming a reconciled reservation');
  },
});
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const request = operationId => ({
  operationId: `${nonce}-${operationId}`,
  principal: { id: 'reconciliation-user', tenantId: 'reconciliation-tenant', plan: 'free' },
  tool: 'reconciliation-tool',
  args: { secret: 'must-never-cross-cloudflare-boundary' },
});

const reserveInput = {
  request: request('lost-ack'),
  units: 1,
  budgets: [{ key: `${nonce}:shared-budget`, limit: 1 }],
  ttlMs: 10_000,
};

// Simulate the exact ambiguous case: Cloudflare commits reserve, then the ACK is lost.
let loseReserveAck = true;
const ambiguousStore = new RemoteCloudflareUsageStore({
  endpoint,
  headers: authHeaders,
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (loseReserveAck) {
      loseReserveAck = false;
      await response.text();
      throw new Error('simulated lost reserve acknowledgement after commit');
    }
    return response;
  },
});

await assert.rejects(
  () => ambiguousStore.reserve(reserveInput),
  error => error instanceof CloudflareUsageTransportError && error.code === 'network',
);

// Explicit reconciliation finds the original committed reservation without reserving again.
const recovered = await reconcileRemoteCloudflareReserve(
  { endpoint, headers: authHeaders },
  reserveInput,
);
assert.equal(recovered.status, 'active');
assert.equal(recovered.state, 'pending');
if (recovered.status !== 'active') throw new Error('expected active reconciliation');
assert.equal(recovered.reservation.operationId, reserveInput.request.operationId);
assert.deepEqual(recovered.reservation.budgetKeys, reserveInput.budgets.map(budget => budget.key));
assert.equal(recovered.reservation.reservedUnits, reserveInput.units);

// Concurrent reconciliation is read-only: all callers see the same reservation.
const concurrent = await Promise.all(
  Array.from({ length: 20 }, () =>
    reconcileRemoteCloudflareReserve({ endpoint, headers: authHeaders }, reserveInput),
  ),
);
for (const result of concurrent) {
  assert.equal(result.status, 'active');
  if (result.status !== 'active') throw new Error('expected active concurrent reconciliation');
  assert.equal(result.reservation.id, recovered.reservation.id);
}

// No reconciliation call consumed another unit, but the original committed reserve still blocks a competitor.
const competitor = await store.reserve({
  request: request('competitor'),
  units: 1,
  budgets: reserveInput.budgets,
  ttlMs: 10_000,
});
assert.deepEqual(competitor, {
  accepted: false,
  reason: 'quota_exceeded',
  limitingBudgetKey: reserveInput.budgets[0].key,
  remaining: 0,
});

// Consumer-style recovery: reattach the reconciled pending reservation without
// re-running policy.quote() or reserve(), then continue the normal lifecycle.
const recoveredLease = control.resumeLease({
  reservation: recovered.reservation,
  ttlMs: reserveInput.ttlMs,
});
await recoveredLease.markLiable();
await recoveredLease.settle(0, 'reconciled-no-charge');

const afterSettlement = await reconcileRemoteCloudflareReserve(
  { endpoint, headers: authHeaders },
  reserveInput,
);
assert.equal(afterSettlement.status, 'settled');
if (afterSettlement.status !== 'settled') throw new Error('expected settled reconciliation');
assert.equal(afterSettlement.actualUnits, 0);

// Settlement released the reserved unit; lookup itself never did.
const afterRelease = await store.reserve({
  request: request('after-release'),
  units: 1,
  budgets: reserveInput.budgets,
  ttlMs: 10_000,
});
assert.equal(afterRelease.accepted, true);
if (afterRelease.accepted) {
  await store.settle({
    reservationId: afterRelease.reservation.id,
    actualUnits: 0,
    outcome: 'cleanup',
  });
}

// A different logical operation has no reservation and is not created by reconciliation.
const absentInput = {
  ...reserveInput,
  request: request('never-reserved'),
};
const absent = await reconcileRemoteCloudflareReserve(
  { endpoint, headers: authHeaders },
  absentInput,
);
assert.equal(absent.status, 'absent');

console.log('Cloudflare reserve reconciliation integration: PASS');
