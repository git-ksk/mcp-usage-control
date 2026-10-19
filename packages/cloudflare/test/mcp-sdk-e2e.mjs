import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Actual official MCP SDK HTTP transport -> Worker -> Cloudflare DO persisted
// accounting and flow state. Client's input_required automatically creates an
// independent tools/call round, and Worker constructs a fresh server each time.
const url = new URL('http://127.0.0.1:8799/test/mcp-sdk');
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { authorization: 'Bearer local-integration-token' } },
});
const client = new Client({ name: 'mcp-cloudflare-http-e2e', version: '1.0.0' }, {
  versionNegotiation: { mode: { pin: '2026-07-28' } },
});
try {
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), 'modern');
  const first = await client.callTool({ name: 'confirm', arguments: {} });
  assert.notEqual(first.isError, true, `first result: ${JSON.stringify(first)}`);
  assert.match(JSON.stringify(first.content), /Cloudflare official SDK durable resume round 1 completed/);
  console.log('Cloudflare workerd + SQLite DO: actual MCP SDK 2026-07-28 input_required/resume PASS');
  const second = await client.callTool({ name: 'confirm', arguments: {} });
  assert.equal(second.isError, true, 'same operation cannot be booked twice after an authoritative completed flow');
  assert.doesNotMatch(JSON.stringify(second), /app-private-state|sdk-flow-v130-budget/,
    'private flow and budget keys must not leak to the MCP client');
  console.log('Cloudflare SDK replay admission denial redacts trusted state PASS');
} finally {
  await client.close();
}
