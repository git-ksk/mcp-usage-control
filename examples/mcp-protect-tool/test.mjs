import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MemoryUsageStore } from 'mcp-usage-control';
import { startExampleServer } from './server.mjs';

const action = () => randomUUID();
const invoke = (client, actionId = action(), mode = 'ok', additionalArgs = {}) =>
  client.callTool({ name: 'demo-report', arguments: { actionId, mode, ...additionalArgs } });

async function withSdk(options, run) {
  const server = await startExampleServer(options);
  let client;
  try {
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(server.url));
    return await run(client, server);
  } finally {
    try { await client?.close(); } finally { await server.close(); }
  }
}

// Failure decorators implement the same Store boundary as the runtime;
// delegate unrelated methods to the real Memory store without losing `this`.
function decorateStore(overrides) {
  const backing = new MemoryUsageStore();
  return new Proxy(backing, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key].bind(null, target);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('official MCP client enforces known-cost settlement, duplicate operation and quota denial', { timeout: 10000 }, () =>
  withSdk({}, async (client, server) => {
    const id = action();
    const first = await invoke(client, id);
    assert.notEqual(first.isError, true);
    assert.match(JSON.stringify(first.content), /Local example report/);
    assert.equal((await invoke(client, id)).isError, true);
    assert.notEqual((await invoke(client)).isError, true);
    const refused = await invoke(client);
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /Usage denied or tool unavailable/);
    assert.equal(server.metrics.handlerEntries, 2);
  }));

test('two concurrent SDK calls cannot both enter metered work with the last reservation', { timeout: 10000 }, async () => {
  let entered;
  const atEntry = new Promise(resolve => { entered = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await withSdk({ budgetLimit: 5, onHandlerEntry: async () => { entered(); await gate; } }, async (client, server) => {
    const first = invoke(client);
    await atEntry;
    try {
      const second = await invoke(client);
      assert.equal(second.isError, true);
      assert.equal(server.metrics.handlerEntries, 1);
    } finally {
      release();
    }
    const result = await first;
    assert.notEqual(result.isError, true);
    assert.equal(server.metrics.handlerEntries, 1);
  });
});

test('caller-supplied principal and plan fields are not accepted as trusted identity', { timeout: 10000 }, () =>
  withSdk({}, async (client, server) => {
    const response = await invoke(client, action(), 'ok', { principalId: 'fake-admin', plan: 'unlimited' });
    assert.equal(response.isError, true);
    assert.equal(server.metrics.handlerEntries, 0);
  }));

test('Store reserve failure prevents handler entry and never allows unmetered work', { timeout: 10000 }, () =>
  withSdk({
    createStore: () => decorateStore({ reserve() { throw new Error('backend currently unavailable'); } }),
  }, async (client, server) => {
    const response = await invoke(client);
    assert.equal(response.isError, true);
    assert.equal(server.metrics.handlerEntries, 0);
  }));

test('raw backend error stays on server, never in SDK-visible result', { timeout: 10000 }, () => {
  const internal = 'INTERNAL_SECRET_SHOULD_NOT_LEAK_IN_MCP_RESULT';
  const errors = [];
  return withSdk({
    onProtectedError: error => { errors.push(error); },
    createStore: () => decorateStore({ reserve() { throw new Error(internal); } }),
  }, async (client, server) => {
    const response = await invoke(client);
    assert.equal(response.isError, true);
    assert.equal(server.metrics.handlerEntries, 0);
    assert.equal(JSON.stringify(response).includes(internal), false);
    assert.match(JSON.stringify(response.content), /Usage denied or tool unavailable/);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, internal);
  });
});

test('lost markLiable ACK after actual commit cannot start handler or refund', { timeout: 10000 }, () =>
  withSdk({
    budgetLimit: 5,
    createStore: () => decorateStore({ async markLiable(store, request) {
      await store.markLiable(request);
      throw new Error('markLiable ACK unavailable');
    } }),
  }, async (client, server) => {
    assert.equal((await invoke(client)).isError, true);
    assert.equal(server.metrics.handlerEntries, 0);
    assert.equal((await invoke(client)).isError, true);
    assert.equal(server.metrics.handlerEntries, 0);
  }));

test('MCP isError result conservatively settles full reserved maximum', { timeout: 10000 }, () =>
  withSdk({ budgetLimit: 8 }, async (client, server) => {
    const result = await invoke(client, action(), 'tool-error');
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Local tool error/);
    assert.equal((await invoke(client)).isError, true);
    assert.equal(server.metrics.handlerEntries, 1);
  }));

test('handler throw after liability never proves zero cost', { timeout: 10000 }, () =>
  withSdk({}, async (client, server) => {
    assert.equal((await invoke(client, action(), 'unknown-cost')).isError, true);
    assert.equal((await invoke(client)).isError, true);
    assert.equal(server.metrics.handlerEntries, 1);
  }));

test('invalid cost classifier fails closed and settles full maximum', { timeout: 10000 }, () =>
  withSdk({ classifySuccessUnits: () => Number.NaN, onProtectedError: e => { assert.equal(e.name, 'UsageClassificationError'); } }, async (client, server) => {
    const bad = await invoke(client);
    assert.equal(bad.isError, true);
    assert.equal((await invoke(client)).isError, true);
    assert.equal(server.metrics.handlerEntries, 1);
  }));

test('settlement committed but ACK lost: no blind retry or paid handler reentry', { timeout: 10000 }, () => {
  let settlements = 0;
  const errors = [];
  return withSdk({
    onProtectedError: e => { errors.push(e); },
    budgetLimit: 5,
    createStore: () => decorateStore({ async settle(store, request) {
      settlements += 1;
      await store.settle(request);
      throw new Error('settle ACK unavailable');
    } }),
  }, async (client, server) => {
    const response = await invoke(client);
    assert.equal(response.isError, true);
    assert.equal(settlements, 1);
    assert.equal(server.metrics.handlerEntries, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, 'UsageSettlementError');
    assert.equal((await invoke(client)).isError, true);
    assert.equal(settlements, 1);
    assert.equal(server.metrics.handlerEntries, 1);
  });
});
