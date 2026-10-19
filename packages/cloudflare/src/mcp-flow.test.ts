import { describe, expect, it } from 'vitest';
import { CloudflareMcpUsageFlowStore, type CloudflareMcpFlowStub } from './mcp-flow.js';
import type { McpUsageFlowRecord } from 'mcp-usage-control-mcp';

function record(): McpUsageFlowRecord {
  const expiresAt = Date.now() + 60_000;
  return {
    flowId: 'cloudflare-flow-00000001',
    binding: { principalId: 'principal-a', tenantId: 'tenant-a', tool: 'read', argsHash: 'a'.repeat(64) },
    lease: { ttlMs: 60_000, reservation: {
      id: 'reservation-a', operationId: 'operation-a', principalId: 'principal-a',
      tenantId: 'tenant-a', tool: 'read', budgetKeys: ['budget-a'], reservedUnits: 2, expiresAt,
    } },
    expiresAt,
    round: 1,
    applicationRequestState: 'safe-server-state',
  };
}

describe('Cloudflare direct MCP FlowStore adapter', () => {
  it('routes one flow to a stable DO, retaining all typed metadata', async () => {
    const domains: string[] = [];
    let payload: string | undefined;
    const stub: CloudflareMcpFlowStub = {
      async suspendFlow(cmd) { payload = cmd.payload; return 'ok'; },
      async consumeFlow() { return payload; },
    };
    const store = new CloudflareMcpUsageFlowStore({
      namespace: { getByName: name => { domains.push(name); return stub; } },
    });
    const original = record();
    await store.suspend(original);
    expect(await store.consume(original.flowId, original.binding)).toEqual(original);
    expect(domains).toEqual(['muc-flow-v1:cloudflare-flow-00000001', 'muc-flow-v1:cloudflare-flow-00000001']);
  });

  it('rejects invalid flow records and oversize payloads before DO mutation', async () => {
    let invoked = false;
    const store = new CloudflareMcpUsageFlowStore({ namespace: {
      getByName() { invoked = true; throw new Error('unexpected RPC'); },
    } });
    const invalid = record();
    invalid.binding.argsHash = 'wrong';
    await expect(store.suspend(invalid)).rejects.toThrow(/SHA-256/);
    const huge = record();
    huge.applicationRequestState = 'a'.repeat(66_000);
    await expect(store.suspend(huge)).rejects.toThrow(/requestState|payload/);
    expect(invoked).toBe(false);
  });

  it('does not retry uncertain RPC writes or claims', async () => {
    const attempts = { suspend: 0, consume: 0 };
    const store = new CloudflareMcpUsageFlowStore({ namespace: { getByName() { return {
      async suspendFlow() { attempts.suspend++; throw new Error('ACK lost'); },
      async consumeFlow() { attempts.consume++; throw new Error('ACK lost'); },
    }; } } });
    const item = record();
    await expect(store.suspend(item)).rejects.toThrow(/ACK lost/);
    await expect(store.consume(item.flowId, item.binding)).rejects.toThrow(/ACK lost/);
    expect(attempts).toEqual({ suspend: 1, consume: 1 });
  });

  it('fails closed when a DO provides a corrupt payload', async () => {
    const store = new CloudflareMcpUsageFlowStore({ namespace: { getByName() { return {
      async suspendFlow() { return 'ok' as const; },
      async consumeFlow() { return '{invalid'; },
    }; } } });
    const item = record();
    await expect(store.consume(item.flowId, item.binding)).rejects.toThrow(/decoded/);
  });
});
