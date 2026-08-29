import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '@modelcontextprotocol/server';
import {
  MemoryUsageStore,
  UsageControl,
  type MarkLiableInput,
  type MarkLiableResult,
  type RenewInput,
  type RenewResult,
  type SettleInput,
  type SettlementResult,
  type UsagePolicy,
} from 'mcp-usage-control';
import {
  McpUsageResumeError,
  MemoryMcpUsageFlowStore,
  protectMultiRoundTool,
  protectTool,
  UnsupportedMcpUsageFlowError,
  UsageClassificationError,
  UsageSettlementError,
  type McpUsageRequestStatePayload,
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


class FlakyRenewStore extends MemoryUsageStore {
  renewCalls = 0;
  override async renew(input: RenewInput): Promise<RenewResult> {
    this.renewCalls += 1;
    if (this.renewCalls === 1) throw new Error('simulated ambiguous renewal timeout');
    return super.renew(input);
  }
}

class CountingRenewStore extends MemoryUsageStore {
  renewCalls = 0;
  override async renew(input: RenewInput): Promise<RenewResult> {
    this.renewCalls += 1;
    return super.renew(input);
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

function contextWithState(state?: unknown, user = 'user-1'): ServerContext {
  return {
    user,
    mcpReq: {
      requestState: () => state,
    },
  } as unknown as ServerContext;
}

function decodedState(result: unknown): McpUsageRequestStatePayload {
  const requestState = (result as { requestState?: string }).requestState;
  if (!requestState) throw new Error('expected wrapped requestState');
  return JSON.parse(requestState) as McpUsageRequestStatePayload;
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

  it('chunks heartbeat delays above the portable timer limit instead of overflowing to 1ms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
    const store = new CountingRenewStore();
    const longTtlMs = 9_000_000_000;
    const longPolicy: UsagePolicy = {
      quote() {
        return {
          decision: 'allow',
          units: 1,
          budget: { key: 'monthly:user-1', limit: 1 },
          reservationTtlMs: longTtlMs,
        };
      },
    };
    const control = new UsageControl(store, longPolicy);
    let finish!: (value: string) => void;
    const protectedHandler = protectTool(
      {
        control,
        tool: 'very_slow_tool',
        noInput: true,
        principal,
        operationId,
        successUnits: () => 0,
      },
      () => new Promise<string>(resolve => { finish = resolve; }),
    );

    const running = protectedHandler(ctx);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.renewCalls).toBe(0);

    // ttl/3 = 3,000,000,000ms. The first chunk stops at the portable
    // setTimeout ceiling rather than overflowing Node's timer to 1ms.
    await vi.advanceTimersByTimeAsync(2_147_483_646);
    expect(store.renewCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(852_516_353);
    expect(store.renewCalls).toBe(1);

    finish('done');
    await expect(running).resolves.toBe('done');
  });

  it('signals renewal uncertainty and later confirmation without changing accounting semantics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
    const store = new FlakyRenewStore();
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
    const control = new UsageControl(store, expiringPolicy);
    const states: string[] = [];
    const protectedHandler = protectTool(
      {
        control,
        tool: 'streaming_tool',
        noInput: true,
        principal,
        operationId,
        successUnits: () => 0,
        onLeaseRenewalState(event) {
          states.push(event.status);
          if (event.status === 'uncertain') throw new Error('observer failure must be isolated');
        },
      },
      () => new Promise<string>(resolve => setTimeout(() => resolve('done'), 35)),
    );

    const running = protectedHandler(ctx);
    await vi.advanceTimersByTimeAsync(11);
    expect(states).toContain('uncertain');
    await vi.advanceTimersByTimeAsync(10);
    expect(states).toEqual(['uncertain', 'confirmed']);
    await vi.advanceTimersByTimeAsync(14);
    await expect(running).resolves.toBe('done');
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

describe('protectMultiRoundTool', () => {
  it('spans input_required rounds with one reservation and settles exactly once on completion', async () => {
    let quoteCalls = 0;
    const resumablePolicy: UsagePolicy = {
      quote() {
        quoteCalls += 1;
        return { decision: 'allow', units: 1, budget: { key: 'monthly:user-1', limit: 1 } };
      },
    };
    const control = new UsageControl(new MemoryUsageStore(), resumablePolicy);
    const flowStore = new MemoryMcpUsageFlowStore();
    const operation = vi.fn(() => 'logical-op');
    const rounds: Array<{ round: number; state?: string }> = [];
    const protectedHandler = protectMultiRoundTool(
      {
        control,
        tool: 'expensive_tool',
        noInput: true,
        principal,
        operationId: operation,
        flowStore,
        suspendTtlMs: 1_000,
        flowId: () => 'flow-000000000001',
        requestState: { mint: payload => JSON.stringify(payload) },
        successUnits: () => 0,
      },
      async (_args, _ctx, flow) => {
        rounds.push({
          round: flow.round,
          ...(flow.applicationRequestState === undefined
            ? {}
            : { state: flow.applicationRequestState }),
        });
        if (flow.round === 0) {
          return {
            resultType: 'input_required',
            inputRequests: { confirm: { kind: 'test' } },
            requestState: 'application-phase-one',
          };
        }
        return { content: [{ type: 'text', text: 'done' }] };
      },
    );

    const first = await protectedHandler(contextWithState());
    expect(quoteCalls).toBe(1);
    expect(operation).toHaveBeenCalledOnce();

    const final = await protectedHandler(contextWithState(decodedState(first)));
    expect(final).toEqual({ content: [{ type: 'text', text: 'done' }] });
    expect(quoteCalls).toBe(1);
    expect(operation).toHaveBeenCalledOnce();
    expect(rounds).toEqual([
      { round: 0 },
      { round: 1, state: 'application-phase-one' },
    ]);
    expect((await nextAdmission(control)).allowed).toBe(true);
  });

  it('treats flow-store consume as authoritative for expiry across clock domains', async () => {
    const base = Date.parse('2026-08-29T00:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(base);

    const control = new UsageControl(new MemoryUsageStore(), policy);
    const backing = new MemoryMcpUsageFlowStore();
    let consumed: import('./index.js').McpUsageFlowRecord | undefined;
    const flowStore = {
      suspend(record: import('./index.js').McpUsageFlowRecord) {
        consumed = structuredClone(record);
        return backing.suspend(record);
      },
      consume(_flowId: string, binding: import('./index.js').McpUsageFlowBinding) {
        if (!consumed) return undefined;
        if (consumed.binding.principalId !== binding.principalId ||
            consumed.binding.tenantId !== binding.tenantId ||
            consumed.binding.tool !== binding.tool ||
            consumed.binding.argsHash !== binding.argsHash) return undefined;
        const result = consumed;
        consumed = undefined;
        return structuredClone(result);
      },
    };

    const protectedHandler = protectMultiRoundTool(
      {
        control,
        tool: 'expensive_tool',
        noInput: true,
        principal,
        operationId,
        flowStore,
        suspendTtlMs: 10_000,
        flowId: () => 'flow-clock-domain-0001',
        requestState: { mint: payload => JSON.stringify(payload) },
        successUnits: () => 0,
      },
      async (_args, _ctx, flow) =>
        flow.round === 0
          ? { resultType: 'input_required', inputRequests: { x: {} } }
          : { content: [{ type: 'text', text: 'done' }] },
    );

    const first = await protectedHandler(contextWithState());
    const state = decodedState(first);

    // Simulate application-host positive skew after an external flow store already
    // authoritatively accepted the token. The UsageStore clock is restored before
    // renewal so this test isolates the removed post-consume host-clock decision.
    vi.setSystemTime(base + 20_000);
    const resumePromise = protectedHandler(contextWithState(state));
    vi.setSystemTime(base + 1_000);
    await expect(resumePromise).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] });
  });

  it('rejects raw unverified requestState before it can be used as accounting authority', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectMultiRoundTool(
      {
        control,
        tool: 'expensive_tool',
        noInput: true,
        principal,
        operationId,
        flowStore: new MemoryMcpUsageFlowStore(),
        suspendTtlMs: 1_000,
        requestState: { mint: payload => JSON.stringify(payload) },
      },
      async () => ({ content: [] }),
    );

    await expect(protectedHandler(contextWithState('raw-client-controlled-string'))).rejects.toBeInstanceOf(
      McpUsageResumeError,
    );
  });

  it('atomically consumes a resume token so concurrent replay enters the handler once', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const flowStore = new MemoryMcpUsageFlowStore();
    let resumeEntries = 0;
    const protectedHandler = protectMultiRoundTool(
      {
        control,
        tool: 'expensive_tool',
        noInput: true,
        principal,
        operationId,
        flowStore,
        suspendTtlMs: 1_000,
        flowId: () => 'flow-000000000002',
        requestState: { mint: payload => JSON.stringify(payload) },
      },
      async (_args, _ctx, flow) => {
        if (flow.round === 0) return { resultType: 'input_required', inputRequests: { x: {} } };
        resumeEntries += 1;
        return { content: [{ type: 'text', text: 'done' }] };
      },
    );

    const first = await protectedHandler(contextWithState());
    const state = decodedState(first);
    const results = await Promise.allSettled([
      protectedHandler(contextWithState(state)),
      protectedHandler(contextWithState(state)),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(resumeEntries).toBe(1);
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(
      McpUsageResumeError,
    );
  });

  it('does not consume a legitimate flow when principal binding mismatches', async () => {
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const flowStore = new MemoryMcpUsageFlowStore();
    const protectedHandler = protectMultiRoundTool(
      {
        control,
        tool: 'expensive_tool',
        noInput: true,
        principal: current => ({ id: (current as unknown as { user: string }).user }),
        operationId,
        flowStore,
        suspendTtlMs: 1_000,
        flowId: () => 'flow-000000000003',
        requestState: { mint: payload => JSON.stringify(payload) },
        successUnits: () => 0,
      },
      async (_args, _ctx, flow) =>
        flow.round === 0
          ? { resultType: 'input_required', inputRequests: { x: {} } }
          : { content: [{ type: 'text', text: 'done' }] },
    );

    const first = await protectedHandler(contextWithState(undefined, 'user-1'));
    const state = decodedState(first);
    await expect(protectedHandler(contextWithState(state, 'attacker'))).rejects.toBeInstanceOf(
      McpUsageResumeError,
    );
    await expect(protectedHandler(contextWithState(state, 'user-1'))).resolves.toEqual({
      content: [{ type: 'text', text: 'done' }],
    });
  });

  it('keeps an abandoned suspended liable flow charged after its explicit TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
    const control = new UsageControl(new MemoryUsageStore(), policy);
    const protectedHandler = protectMultiRoundTool(
      {
        control,
        tool: 'expensive_tool',
        noInput: true,
        principal,
        operationId,
        flowStore: new MemoryMcpUsageFlowStore(),
        suspendTtlMs: 30,
        flowId: () => 'flow-000000000004',
        requestState: { mint: payload => JSON.stringify(payload) },
      },
      async () => ({ resultType: 'input_required', inputRequests: { x: {} } }),
    );

    await protectedHandler(contextWithState());
    await vi.advanceTimersByTimeAsync(31);
    await expect(nextAdmission(control)).resolves.toEqual(exhausted);
  });
});
