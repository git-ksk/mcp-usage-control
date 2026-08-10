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
const principal = () => ({ id: 'user-1' });
const operationId = () => 'op-a';
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

function nextAdmission(control: UsageControl) {
  return control.reserve({
    operationId: 'op-b',
    principal: { id: 'user-1' },
    tool: 'expensive_tool',
    args: {},
  });
}

const exhausted = {
  allowed: false as const,
  reason: 'quota_exceeded',
  limitingBudgetKey: 'monthly:user-1',
  remaining: 0,
};

afterEach(() => vi.useRealTimers());

describe('protectTool', () => {
  it('charges the full reservation on an unclassified thrown error', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectTool(
      { control, tool: 'expensive_tool', noInput: true, principal, operationId },
      async () => {
        throw new Error('upstream timeout');
      },
    );

    await expect(protectedHandler(ctx)).rejects.toThrow('upstream timeout');
    await expect(nextAdmission(control)).resolves.toEqual(exhausted);
  });

  it('allows an explicit zero-cost thrown-error classification', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectTool(
      {
        control,
        tool: 'expensive_tool',
        noInput: true,
        principal,
        operationId,
        errorUnits: () => 0,
      },
      async () => {
        throw new Error('failed before metered upstream work');
      },
    );

    await expect(protectedHandler(ctx)).rejects.toThrow();
    expect((await nextAdmission(control)).allowed).toBe(true);
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
        noInput: true,
        principal,
        operationId,
        toolErrorUnits,
        successUnits,
      },
      async () => result,
    );

    await expect(protectedHandler(ctx)).resolves.toBe(result);
    expect(toolErrorUnits).toHaveBeenCalledOnce();
    expect(successUnits).not.toHaveBeenCalled();
    expect((await nextAdmission(control)).allowed).toBe(true);
  });

  it.each([
    ['throws', () => { throw new Error('classifier bug'); }],
    ['returns invalid units', () => -1],
  ])('charges the full reservation if success classifier %s', async (_name, successUnits) => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectTool(
      {
        control,
        tool: 'expensive_tool',
        noInput: true,
        principal,
        operationId,
        successUnits,
      },
      async () => 'ok',
    );

    await expect(protectedHandler(ctx)).rejects.toBeInstanceOf(UsageClassificationError);
    await expect(nextAdmission(control)).resolves.toEqual(exhausted);
  });

  it('rejects input_required instead of silently mis-accounting it', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectTool(
      { control, tool: 'confirm_then_write', noInput: true, principal, operationId },
      async () => ({ resultType: 'input_required', inputRequests: {} }),
    );

    await expect(protectedHandler(ctx)).rejects.toBeInstanceOf(UnsupportedMcpUsageFlowError);
    await expect(nextAdmission(control)).resolves.toEqual(exhausted);
  });

  it('does not enter the handler if markLiable fails', async () => {
    const control = new UsageControl(new FailingMarkLiableStore(), policy);
    const handler = vi.fn(async () => 'ok');
    const protectedHandler = protectTool(
      { control, tool: 'expensive_tool', noInput: true, principal, operationId },
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
        noInput: true,
        principal,
        operationId,
        errorUnits,
      },
      async () => 'ok',
    );

    await expect(protectedHandler(ctx)).rejects.toBeInstanceOf(UsageSettlementError);
    expect(store.settleCalls).toBe(1);
    expect(errorUnits).not.toHaveBeenCalled();
  });

  it('preserves execution error when error settlement is ambiguous', async () => {
    const store = new FailingSettlementStore();
    const control = new UsageControl(store, policy);
    const executionError = new Error('upstream failed');
    const protectedHandler = protectTool(
      { control, tool: 'expensive_tool', noInput: true, principal, operationId },
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

  it('renews a cost-liable reservation while a long handler runs', async () => {
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
        noInput: true,
        principal,
        operationId,
        successUnits: () => 0,
      },
      () => new Promise<string>(resolve => setTimeout(() => resolve('done'), 100)),
    );

    const running = protectedHandler(ctx);
    await vi.advanceTimersByTimeAsync(40);
    await expect(
      control.reserve({
        operationId: 'op-b',
        principal: { id: 'user-1' },
        tool: 'slow_tool',
        args: {},
      }),
    ).resolves.toEqual(exhausted);

    await vi.advanceTimersByTimeAsync(60);
    await expect(running).resolves.toBe('done');
  });
});
