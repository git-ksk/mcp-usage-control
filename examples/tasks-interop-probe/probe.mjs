import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { Server } from '@modelcontextprotocol/server';
import { bindTaskReceiver } from '@modelcontextprotocol/ext-tasks/receiver';
import { createTaskSessionFromClient } from '@modelcontextprotocol/ext-tasks/client';

const client = new Client({ name: 'muc-tasks-interop-probe', version: '0.0.0' }, {
  capabilities: { sampling: {} },
});
const server = new Server({ name: 'muc-tasks-interop-probe', version: '0.0.0' }, {
  capabilities: { tools: {} },
});
assert.equal(typeof createTaskSessionFromClient, 'function');
assert.equal(typeof server.setRequestHandler, 'function');
const receiver = bindTaskReceiver(client, {
  methods: { 'sampling/createMessage': true },
  sampling: async () => ({ model: 'noop', role: 'assistant', content: { type: 'text', text: 'ok' } }),
  createTaskId: () => 'probe-fixed-id',
});
const supportedHandlers = Array.from(client._requestHandlers.keys());
assert(supportedHandlers.includes('tasks/get'));
assert(supportedHandlers.includes('tasks/result'));
assert(supportedHandlers.includes('tasks/list'));
assert(supportedHandlers.includes('tasks/cancel'));
assert(!supportedHandlers.includes('tasks/update'));
assert(!supportedHandlers.includes('tools/call'));
assert.deepEqual(receiver.capabilities.requests, { sampling: { createMessage: {} } });
receiver.close();
assert.throws(
  () => bindTaskReceiver(client, { methods: { 'tools/call': true }, createTaskId: () => 'fixed' }),
  /Enabled receiver method tools\/call requires a callback/,
);
console.log(JSON.stringify({
  officialSdkClient: '@modelcontextprotocol/client@2.3.1',
  officialSdkServer: '@modelcontextprotocol/server@2.3.1',
  extension: '@modelcontextprotocol/ext-tasks@0.2.2',
  receiverBoundTo: 'SDK Client',
  installedReceiverMethods: supportedHandlers.filter(k => k.startsWith('tasks/')),
  toolsCallTaskReceiver: false,
  tasksUpdateReceiver: false,
  decision: 'DEFER first-class Tasks server adapter; keep existing app-owned composition',
}, null, 2));
