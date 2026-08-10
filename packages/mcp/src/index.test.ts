import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '@modelcontextprotocol/server';
import {
  MemoryUsageStore,
  UsageControl,
  type MarkLiableInput,
  type MarkLiableResult,
  type SettleInput,
  type SettlementResult,
  type UsagePolicy,
} from '@mcp-usage-control/core';
import {
  protectTool,
  UnsupportedMcpUsageFlowError,
  UsageClassificationError,
  UsageSettlementError,
} from './index.js';

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

class FailingMarkLiableStore extends MemoryUsageStore {
  override async markLiable(_input: MarkLiableInput): Promise<MarkLiableResult> {
    throw new Error('mark-liable unavailable');
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('protectTool', () => {
  it('charges the full reservation on an unclassified thrown error', async () => {
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

    await expect(protectedHandler(ctx)).rejects.toThrow('upstream timeout');
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

    await expect(protectedHandler(ctx)).rejects.toThrow();
    const next = await control.reserve({
      operationId: 'op-b',
      principal: { id: 'user-1' },
      tool: 'expensive_tool',
      args: {},
    });
    expect(next.allowed).toBe(true);
  });

  it('treats MCP isError results as tool errors, not success', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const toolErrorUnits = vi.fn(() => 0);
    const successUnits = vi.fn(() => 1);
    const result = { content: [{ type: 'text', text: 'not found' }], isError: true };
    const protectedHandler = protectTool(
      {
        control,
        tool: 'read_item',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
        toolErrorUnits,
        successUnits,
      },
      async () => result,
    );

    await expect(protectedHandler(ctx)).resolves.toBe(result);
    expect(toolErrorUnits).toHaveBeenCalledOnce();
    expect(successUnits).not.toHaveBeenCalled();
    const next = await control.reserve({
      operationId: 'op-b',
      principal: { id: 'user-1' },
      tool: 'read_item',
      args: {},
    });
    expect(next.allowed).toBe(true);
  });

  it('charges the full reservation if success cost classification throws', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectTool(
      {
        control,
        tool: 'expensive_tool',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
        successUnits: () => {
          throw new Error('classifier bug');
        },
      },
      async () => 'ok',
    );

    await expect(protectedHandler(ctx)).rejects.toBeInstanceOf(UsageClassificationError);
    const next = await control.reserve({
      operationId: 'op-b',
      principal: { id: 'user-1' },
      tool: 'expensive_tool',
      args: {},
    });
    expect(next).toEqual({ allowed: false, reason: 'quota_exceeded', remaining: 0 });
  });

  it('charges the full reservation if a classifier returns invalid units', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectTool(
      {
        control,
        tool: 'expensive_tool',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
        successUnits: () => -1,
      },
      async () => 'ok',
    );

    await expect(protectedHandler(ctx)).rejects.toBeInstanceOf(UsageClassificationError);
    const next = await control.reserve({
      operationId: 'op-b',
      principal: { id: 'user-1' },
      tool: 'expensive_tool',
      args: {},
    });
    expect(next).toEqual({ allowed: false, reason: 'quota_exceeded', remaining: 0 });
  });

  it('rejects input_required multi-round results instead of mis-accounting them', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectTool(
      {
        control,
        tool: 'confirm_then_write',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
      },
      async () => ({ resultType: 'input_required', inputRequests: {} }),
    );

    await expect(protectedHandler(ctx)).rejects.toBeInstanceOf(UnsupportedMcpUsageFlowError);
    const next = await control.reserve({
      operationId: 'op-b',
      principal: { id: 'user-1' },
      tool: 'confirm_then_write',
      args: {},
    });
    expect(next).toEqual({ allowed: false, reason: 'quota_exceeded', remaining: 0 });
  });

  it('does not enter the handler if marking the reservation cost-liable fails', async () => {
    const control = new UsageControl(new FailingMarkLiableStore(), policy);
    const handler = vi.fn(async () => 'ok');
    const protectedHandler = protectTool(
      {
        control,
        tool: 'expensive_tool',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
      },
      handler,
    );

    await expect(protectedHandler(ctx)).rejects.toThrow('mark-liable unavailable');
    expect(handler).not.toHaveBeenCalled();
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

    await expect(protectedHandler(ctx)).rejects.toBeInstanceOf(UsageSettlementError);
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
      await protectedHandler(ctx);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UsageSettlementError);
    expect((caught as UsageSettlementError).executionError).toBe(executionError);
    expect(store.settleCalls).toBe(1);
  });

  it('renews the reservation while a protected handler runs past its initial TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));

    const expiringPolicy: UsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          units: 1,
          budget: { key: 'monthly:user-1', limit: 1 },
          reservationTtlMs: 30,
        };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), expiringPolicy);
    const protectedHandler = protectTool(
      {
        control,
        tool: 'slow_tool',
        principal: () => ({ id: 'user-1' }),
        operationId: () => 'op-a',
        successUnits: () => 0,
      },
      () => new Promise<string>(resolve => setTimeout(() => resolve('done'), 100)),
    );

    const running = protectedHandler(ctx);
    await vi.advanceTimersByTimeAsync(40);

    const concurrent = await control.reserve({
      operationId: 'op-b',
      principal: { id: 'user-1' },
      tool: 'slow_tool',
      args: {},
    });
    expect(concurrent).toEqual({ allowed: false, reason: 'quota_exceeded', remaining: 0 });

    await vi.advanceTimersByTimeAsync(60);
    await expect(running).resolves.toBe('done');
  });
});
