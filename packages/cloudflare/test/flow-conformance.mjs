import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';

const endpoint = process.env.MCP_USAGE_CLOUDFLARE_URL?.replace(/\/v1\/usage-store$/, '/test/mcp-flow') ??
  'http://127.0.0.1:8799/test/mcp-flow';
const token = process.env.MCP_USAGE_CLOUDFLARE_TOKEN ?? 'local-integration-token';

async function send(body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const decoded = await response.json();
  if (!response.ok || decoded.ok !== true) throw new Error(`Cloudflare MCP flow response status ${response.status}`);
  return decoded;
}

const remote = {
  async suspend(record) { await send({ action: 'suspend', record }); },
  async consume(flowId, binding) {
    return (await send({ action: 'consume', flowId, binding })).record ?? undefined;
  },
};

const report = await assertMcpUsageFlowStoreConformance({
  createStore: () => remote,
  async waitForFlowExpiry(ttlMs) {
    await new Promise(resolve => setTimeout(resolve, ttlMs + 350));
  },
  flowTtlMs: 1_500,
  concurrency: 16,
});
assert.equal(report.passed, true, JSON.stringify(report.cases.filter(x => !x.passed)));
console.log('Cloudflare DO MCP Flow Store: five portable conformance scenarios passed');

function flow(id = `ack-${randomUUID()}`) {
  const expiresAt = Date.now() + 60_000;
  return {
    flowId: id,
    binding: { principalId: 'alice', tenantId: 'tenant-a', tool: 'search', argsHash: 'a'.repeat(64) },
    lease: {
      reservation: { id: 'reservation-1', operationId: 'operation-1', principalId: 'alice',
        tenantId: 'tenant-a', tool: 'search', budgetKeys: ['quota'], reservedUnits: 2, expiresAt },
      ttlMs: 60_000,
    },
    round: 1,
    expiresAt,
    applicationRequestState: 'retained-private-input',
  };
}

// Ack losses deliberately throw AFTER a real workerd DB write/claim.
const lostSuspend = flow();
await assert.rejects(async () => {
  await remote.suspend(lostSuspend);
  throw new Error('suspend ACK lost');
}, /suspend ACK lost/);
await assert.rejects(() => remote.suspend(lostSuspend), /409/);
assert.deepEqual(await remote.consume(lostSuspend.flowId, lostSuspend.binding), lostSuspend);

const lostConsume = flow();
await remote.suspend(lostConsume);
await assert.rejects(async () => {
  assert.deepEqual(await remote.consume(lostConsume.flowId, lostConsume.binding), lostConsume);
  throw new Error('consume ACK lost');
}, /consume ACK lost/);
assert.equal(await remote.consume(lostConsume.flowId, lostConsume.binding), undefined);
await assert.rejects(() => remote.suspend(lostConsume), /409/, 'consumed tombstone must prevent duplicate reuse');

const bad = flow();
await remote.suspend(bad);
assert.equal(await remote.consume(bad.flowId, { ...bad.binding, tenantId: 'other' }), undefined);
assert.equal(await remote.consume(bad.flowId, { ...bad.binding, argsHash: 'b'.repeat(64) }), undefined);
assert.deepEqual(await remote.consume(bad.flowId, bad.binding), bad);
console.log('Cloudflare DO Flow Store: lost ACK, replay tombstone and cross-tenant isolation passed');
