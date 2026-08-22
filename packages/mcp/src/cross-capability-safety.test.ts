import { describe, expect, it } from 'vitest';
import { MemoryMcpUsageFlowStore, type McpUsageFlowRecord } from './index.js';

describe('cross-capability MCP safety matrix', () => {
  it('preserves a detached unresolved growth fence across a Memory flow-store roundtrip', async () => {
    const expiresAt = Date.now() + 5_000;
    const record: McpUsageFlowRecord = {
      flowId: 'flow-cross-capability-0001',
      binding: { principalId: 'user-1', tool: 'write', argsHash: 'a'.repeat(64) },
      lease: {
        reservation: {
          id: 'reservation-1', operationId: 'operation-1', principalId: 'user-1', tool: 'write',
          budgetKeys: ['budget:monthly'], reservedUnits: 1, expiresAt,
        },
        ttlMs: 5_000,
        unresolvedGrowth: {
          incrementId: 'stable-growth', additionalUnits: 1, budgets: [{ key: 'budget:monthly', limit: 3 }],
        },
      },
      round: 1,
      expiresAt,
    };
    const store = new MemoryMcpUsageFlowStore();
    await store.suspend(record);
    (record.lease.unresolvedGrowth!.budgets as Array<{ key: string; limit: number }>)[0]!.limit = 999;
    const resumed = await store.consume(record.flowId, record.binding);
    expect(resumed?.lease.unresolvedGrowth).toEqual({
      incrementId: 'stable-growth', additionalUnits: 1, budgets: [{ key: 'budget:monthly', limit: 3 }],
    });
    expect(resumed?.lease.unresolvedGrowth).not.toBe(record.lease.unresolvedGrowth);
  });
});
