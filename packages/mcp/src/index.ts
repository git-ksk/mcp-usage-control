import type { ServerContext } from '@modelcontextprotocol/server';
import {
  UsageDeniedError,
  type Principal,
  type UsageControl,
  type UsageLease,
} from '@mcp-usage-control/core';

type MaybePromise<T> = T | Promise<T>;

export interface ProtectToolOptions<TArgs, TResult> {
  control: UsageControl;
  tool: string;
  principal(ctx: ServerContext): MaybePromise<Principal>;
  operationId(args: TArgs, ctx: ServerContext): MaybePromise<string>;
  successUnits?(input: {
    result: TResult;
    args: TArgs;
    ctx: ServerContext;
    lease: UsageLease;
  }): MaybePromise<number>;
  errorUnits?(input: {
    error: unknown;
    args: TArgs;
    ctx: ServerContext;
    lease: UsageLease;
  }): MaybePromise<number>;
}

/**
 * Wrap an MCP v2 tool handler with usage admission and settlement.
 *
 * Error settlement is conservative by default: the full reservation is charged.
 * Applications may return a lower amount only when they can prove the failure
 * happened before the metered cost was incurred.
 */
export function protectTool<TArgs, TResult>(
  options: ProtectToolOptions<TArgs, TResult>,
  handler: (args: TArgs, ctx: ServerContext) => MaybePromise<TResult>,
): (args: TArgs, ctx: ServerContext) => Promise<TResult> {
  return async (args, ctx) => {
    const principal = await options.principal(ctx);
    const operationId = await options.operationId(args, ctx);
    const admission = await options.control.reserve({
      operationId,
      principal,
      tool: options.tool,
      args,
    });

    if (!admission.allowed) {
      throw new UsageDeniedError(admission.reason);
    }

    const { lease } = admission;
    try {
      const result = await handler(args, ctx);
      const actualUnits = options.successUnits
        ? await options.successUnits({ result, args, ctx, lease })
        : lease.reservedUnits;
      await lease.settle(actualUnits, 'success');
      return result;
    } catch (error) {
      const actualUnits = options.errorUnits
        ? await options.errorUnits({ error, args, ctx, lease })
        : lease.reservedUnits;
      await lease.settle(actualUnits, 'error');
      throw error;
    }
  };
}
