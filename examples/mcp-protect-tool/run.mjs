import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startExampleServer } from './server.mjs';

async function withExample(run) {
  const server = await startExampleServer();
  let client;
  try {
    client = new Client({ name: 'usage-control-example-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(server.url));
    await run(client, server);
  } finally {
    try { await client?.close(); } finally { await server.close(); }
  }
}

async function call(client, actionId, mode = 'ok') {
  return client.callTool({ name: 'demo-report', arguments: { actionId, mode } });
}

await withExample(async (client, server) => {
  const firstAction = randomUUID();
  const first = await call(client, firstAction);
  assert.notEqual(first.isError, true, 'first action should succeed');
  assert.match(JSON.stringify(first.content), /Local example report/);
  assert.equal(server.metrics.handlerEntries, 1);

  const replay = await call(client, firstAction);
  assert.equal(replay.isError, true, 'duplicate logical action must be refused');
  assert.equal(server.metrics.handlerEntries, 1, 'duplicate must not execute paid work');

  const second = await call(client, randomUUID());
  assert.notEqual(second.isError, true);
  assert.equal(server.metrics.handlerEntries, 2);

  // Reservations quote a safe maximum of 5 units each; both successes charged
  // 3 each, leaving only 2 of 8 units, so a further 5-unit quote is denied.
  const denied = await call(client, randomUUID());
  assert.equal(denied.isError, true, 'quota must deny before paid work');
  assert.equal(server.metrics.handlerEntries, 2);
  assert.match(JSON.stringify(denied.content), /Usage denied/);
  console.log('PASS: real loopback MCP calls settle actual usage; duplicates and exhausted budgets deny before work.');
});

await withExample(async (client, server) => {
  const uncertain = await call(client, randomUUID(), 'unknown-cost');
  assert.equal(uncertain.isError, true);
  assert.equal(server.metrics.handlerEntries, 1);
  const next = await call(client, randomUUID());
  assert.equal(next.isError, true, 'unknown post-dispatch cost conservatively consumes five units');
  assert.equal(server.metrics.handlerEntries, 1);
  console.log('PASS: unknown post-dispatch cost does not silently refund; no business replay.');
});
