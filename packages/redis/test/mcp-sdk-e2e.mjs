import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createClient } from 'redis';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  McpServer, createMcpHandler, createRequestStateCodec, inputRequired,
} from '@modelcontextprotocol/server';
import { UsageControl } from 'mcp-usage-control';
import { protectMultiRoundTool } from 'mcp-usage-control-mcp';
import { RedisUsageStore } from 'mcp-usage-control-redis';
import { RedisMcpUsageFlowStore } from 'mcp-usage-control-redis/mcp-flow';

assert.ok(process.env.REDIS_URL, 'Real Redis service required for official SDK E2E');
const redis = createClient({ url: process.env.REDIS_URL, database: 13 });
await redis.connect();
const ns = randomUUID().replaceAll('-', '');
const accountPrefix = `sdk_e2e_account_${ns}`;
const flowPrefix = `sdk_e2e_flows_${ns}`;
const stateCodec = createRequestStateCodec({ key: '0123456789abcdef0123456789abcdef', ttlSeconds: 60 });
let quotes = 0;
let resumedCalls = 0;
const entered = [];
const policy = {
  quote() {
    quotes += 1;
    return { decision: 'allow', units: 1, budget: { key: `sdk-${ns}`, limit: 1 } };
  },
};
const handlers = [];

function createNode(node) {
  const account = new RedisUsageStore(redis, { prefix: accountPrefix, hashTag: 'account' });
  const flowStore = new RedisMcpUsageFlowStore(redis, { prefix: flowPrefix });
  const control = new UsageControl(account, policy);
  const protectedHandler = protectMultiRoundTool({
    control,
    tool: 'confirm',
    noInput: true,
    principal: () => ({ id: 'alice', tenantId: 'tenant-1' }),
    operationId: () => 'original-operation',
    flowStore,
    suspendTtlMs: 30_000,
    requestState: { mint: payload => stateCodec.mint(payload) },
    successUnits: () => 0,
    leaseHeartbeat: false,
  }, async (_args, ctx, flow) => {
    entered.push({ node, round: flow.round, operationId: flow.operationId, requestId: String(ctx.mcpReq.id) });
    if (flow.round === 0) {
      return inputRequired({ inputRequests: {}, requestState: 'application-state-from-first-node' });
    }
    resumedCalls++;
    assert.equal(flow.applicationRequestState, 'application-state-from-first-node');
    return { content: [{ type: 'text', text: 'finished on a different replica' }] };
  });
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: `mcp-redis-${node}`, version: '1.0.0' },
      { requestState: { verify: stateCodec.verify } },
    );
    server.registerTool('confirm', { description: 'Official SDK cross-replica flow proof' }, protectedHandler);
    return server;
  });
  handlers.push(handler);
  return handler;
}

const a = createNode('a');
const b = createNode('b');
let toolCalls = 0;
const httpServer = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = Buffer.concat(chunks);
    let method;
    try { method = JSON.parse(body.toString()).method; } catch { /* non-JSON traffic */ }
    const handler = method === 'tools/call' && toolCalls++ >= 1 ? b : a;
    const request = new Request(`http://127.0.0.1:${httpServer.address().port}${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(req.method === 'POST' ? { body, duplex: 'half' } : {}),
    });
    const reply = await handler.fetch(request);
    res.writeHead(reply.status, Object.fromEntries(reply.headers));
    res.end(Buffer.from(await reply.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server failed');
  }
});
let client;
try {
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
  client = new Client({ name: 'redis-sdk-cross-replica', version: '1.0.0' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  });
  await client.connect(new StreamableHTTPClientTransport(url));
  assert.equal(client.getProtocolEra(), 'modern');
  const result = await client.callTool({ name: 'confirm', arguments: {} });
  assert.match(JSON.stringify(result.content), /finished on a different replica/);
  assert.equal(quotes, 1, 'one original admission, no reservation on resumed round');
  assert.equal(toolCalls, 2, 'one initial tools/call and one wire retry');
  assert.equal(resumedCalls, 1, 'one billable resume call');
  assert.deepEqual(entered.map(x => [x.node, x.round, x.operationId]), [
    ['a', 0, 'original-operation'], ['b', 1, 'original-operation'],
  ]);
  assert.notEqual(entered[0].requestId, entered[1].requestId);
  const verification = new UsageControl(new RedisUsageStore(redis, {
    prefix: accountPrefix, hashTag: 'account',
  }), policy);
  const later = await verification.reserve({
    operationId: 'independent-followup', principal: { id: 'alice', tenantId: 'tenant-1' }, tool: 'confirm', args: undefined,
  });
  assert.equal(later.allowed, true, 'zero-cost settlement must restore budget capacity');
  if (later.allowed) await later.lease.settle(0, 'verification');
  console.log('Redis real HTTP official SDK 2026-07-28 multi-round cross-replica flow passed');
} finally {
  await client?.close();
  for (const handler of handlers) await handler.close();
  httpServer.close();
  await redis.quit();
}
