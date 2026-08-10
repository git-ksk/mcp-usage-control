import { describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '@modelcontextprotocol/server';
import {
  MemoryUsageStore,
  UsageControl,
  type SettleInput,
  type SettlementResult,
  type UsagePolicy,
} from '@mcp-usage-control/core';
import { protectTool, UsageSettlementError } from './index.js';

const ctx = {} as ServerContext;

const policy: UsagePolicy = {
  quote() {
    return { decision: 'allow', units: 1, budget: { key: 'monthly:user-1', limit: 1 } };
  },
};

class FailingSettlementStore extends MemoryUsageStore {
  settleCalls = 0;

  override async settle(_input: SettleInput): Promise<SettlementResult> {
    this.settleCalls += 1;
    throw new Error('ambiguous Redis timeout');
  }
}

describe('protectTool', () => {
  it('charges the full reservation on an unclassified error', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectTool(
      {
        control,
        tool: 'expensive_tool',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
      },
      async () => {
        throw new Error('upstream timeout');
      },
    );

    await expect(protectedHandler({}, ctx)).rejects.toThrow('upstream timeout');
    const next = await control.reserve({
      operationId: 'op-b',
      principal: { id: 'user-1' },
      tool: 'expensive_tool',
      args: {},
    });
    expect(next).toEqual({ allowed: false, reason: 'quota_exceeded', remaining: 0 });
  });

  it('allows an explicit zero-cost pre-execution failure classification', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectTool(
      {
        control,
        tool: 'expensive_tool',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
        errorUnits: () => 0,
      },
      async () => {
        throw new Error('validation failed before upstream call');
      },
    );

    await expect(protectedHandler({}, ctx)).rejects.toThrow();
    const next = await control.reserve({
      operationId: 'op-b',
      principal: { id: 'user-1' },
      tool: 'expensive_tool',
      args: {},
    });
    expect(next.allowed).toBe(true);
  });

  it('does not reclassify or retry an ambiguous settlement failure', async () => {
    const store = new FailingSettlementStore();
    const control = new UsageControl(store, policy);
    const errorUnits = vi.fn(() => 0);
    const protectedHandler = protectTool(
      {
        control,
        tool: 'expensive_tool',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
        errorUnits,
      },
      async () => 'ok',
    );

    await expect(protectedHandler({}, ctx)).rejects.toBeInstanceOf(UsageSettlementError);
    expect(store.settleCalls).toBe(1);
    expect(errorUnits).not.toHaveBeenCalled();
  });

  it('preserves the execution error when error settlement is ambiguous', async () => {
    const store = new FailingSettlementStore();
    const control = new UsageControl(store, policy);
    const executionError = new Error('upstream failed');
    const protectedHandler = protectTool(
      {
        control,
        tool: 'expensive_tool',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
      },
      async () => {
        throw executionError;
      },
    );

    let caught: unknown;
    try {
      await protectedHandler({}, ctx);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UsageSettlementError);
    expect((caught as UsageSettlementError).executionError).toBe(executionError);
    expect(store.settleCalls).toBe(1);
  });
});
