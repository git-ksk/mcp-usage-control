import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { MemoryUsageStore, UsageControl, createWindowedBudgetKey } from 'mcp-usage-control';
import { protectTool } from 'mcp-usage-control-mcp';
import { safeDenialResult } from './denial-projection.mjs';

/** A runnable, in-process official MCP SDK example; use real Redis/DO/Firestore
 * Stores instead of Memory in production. Caller principal is a TEST fixture,
 * NOT production authentication. The SDK dispatch path is genuine. */
export async function runQuotaDenialSdkExample() {
  const principal = { id: 'local-test-user', tenantId: 'local-test-tenant' };
  const calendar = createWindowedBudgetKey({ period: 'calendar-day', timeZone: 'Asia/Tokyo', namespace: 'private-credits' });
  const window = calendar.window({ scope: 'principal', id: principal.id, now: Date.parse('2026-10-19T12:00:00Z') });
  const sharedKey = 'private:shared:tenant-A:billing-plan-code';
  const store = new MemoryUsageStore();
  let handlerEntries = 0;
  const control = new UsageControl(store, {
    quote() {
      return { decision: 'allow', units: 1, budgets: [
        { key: window.key, limit: 1 },
        { key: sharedKey, limit: 1 },
      ] };
    },
  });
  const allowedScopes = new Map([[window.key, 'daily'], [sharedKey, 'shared']]);
  const allowedBoundaries = new Map([[window.key, window.endsAt]]);
  const guarded = protectTool({
    control, tool: 'demo-confirm', noInput: true,
    principal: () => principal,
    operationId: (_args, ctx) => `local-${ctx.mcpReq.id}`,
    leaseHeartbeat: false,
    successUnits: () => 1,
  }, async () => {
    handlerEntries++;
    return { content: [{ type: 'text', text: 'paid work completed' }] };
  });
  let observedErrors = 0;
  const safeHandler = async (ctx) => {
    try { return await guarded(ctx); }
    catch (error) {
      try { observedErrors++; } catch { /* diagnostics never affect accounting */ }
      return safeDenialResult(error, {
        approvedScopes: allowedScopes,
        approvedNextBoundaryByKey: allowedBoundaries,
      });
    }
  };
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'safe-quota-denial-example', version: '1.0.0' }, { maxToolInputElements: 128 });
    server.registerTool('demo-confirm', { description: 'Trusted quota projection example' }, safeHandler);
    return server;
  }, { maxRequestBodySize: 64 * 1024 });
  const oversized = await handler.fetch(new Request('http://test.local/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(64 * 1024 + 1),
  }));
  assert.equal(oversized.status, 413, 'oversized denial-demo input must fail before tool dispatch');
  assert.equal(handlerEntries, 0);
  const client = new Client({ name: 'safe-quota-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }));
    const first = await client.callTool({ name: 'demo-confirm', arguments: {} });
    const second = await client.callTool({ name: 'demo-confirm', arguments: {} });
    assert.notEqual(first.isError, true);
    assert.equal(second.isError, true);
    assert.equal(handlerEntries, 1);
    assert.equal(observedErrors, 1);
    assert.deepEqual(second.structuredContent, {
      status: 'denied', reason: 'quota_exceeded', scope: 'daily',
      nextWindowBoundary: new Date(window.endsAt).toISOString(), retrySafeAt: null,
    });
    for (const secret of [window.key, sharedKey, principal.id, principal.tenantId]) {
      assert.equal(JSON.stringify(second).includes(secret), false, `private identifier leaked`);
    }
    return { first, second, handlerEntries };
  } finally {
    await client.close();
    await handler.close();
  }
}
