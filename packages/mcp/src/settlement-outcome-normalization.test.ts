import { describe, expect, it } from 'vitest';
import type { ServerContext } from '@modelcontextprotocol/server';
import {
  MemoryUsageStore,
  UsageControl,
  type SettleInput,
  type SettlementResult,
  type UsagePolicy,
} from 'mcp-usage-control';
import { protectTool } from './index.js';

const ctx = {} as ServerContext;
const policy: UsagePolicy = {
  quote() {
    return {
      decision: 'allow',
      units: 1,
      budget: { key: 'settlement-normalization', limit: 10 },
    };
  },
};

class RecordingStore extends MemoryUsageStore {
  readonly outcomes: string[] = [];

  override async settle(input: SettleInput): Promise<SettlementResult> {
    this.outcomes.push(input.outcome);
    return super.settle(input);
  }
}

function protectedHandler(
  store: RecordingStore,
  handler: () => Promise<unknown>,
  options: {
    toolErrorUnits?: () => number;
    errorUnits?: () => number;
  } = {},
) {
  const control = new UsageControl(store, policy);
  return protectTool(
    {
      control,
      tool: 'normalized-tool',
      noInput: true,
      principal: () => ({ id: 'user-1' }),
      operationId: () => `op-${store.outcomes.length}`,
      leaseHeartbeat: false,
      ...options,
    },
    handler,
  );
}

describe('MCP settlement outcome normalization', () => {
  it('normalizes success to completed before Store settlement', async () => {
    const store = new RecordingStore();
    const handler = protectedHandler(store, async () => ({ content: [] }));

    await expect(handler(ctx)).resolves.toEqual({ content: [] });
    expect(store.outcomes).toEqual(['completed']);
  });

  it('normalizes tool_error to completed before Store settlement', async () => {
    const store = new RecordingStore();
    const result = { content: [], isError: true };
    const handler = protectedHandler(store, async () => result, { toolErrorUnits: () => 1 });

    await expect(handler(ctx)).resolves.toBe(result);
    expect(store.outcomes).toEqual(['completed']);
  });

  it('normalizes thrown-error settlement to dispatched_conservative', async () => {
    const store = new RecordingStore();
    const handler = protectedHandler(
      store,
      async () => {
        throw new Error('provider failed');
      },
      { errorUnits: () => 1 },
    );

    await expect(handler(ctx)).rejects.toThrow('provider failed');
    expect(store.outcomes).toEqual(['dispatched_conservative']);
  });
});
