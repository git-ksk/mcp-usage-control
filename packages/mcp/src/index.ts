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
  /** Disable only when the application renews the lease itself. Defaults to true. */
  leaseHeartbeat?: boolean;
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

export class UsageSettlementError extends Error {
  constructor(
    message: string,
    public readonly settlementError: unknown,
    public readonly executionError?: unknown,
  ) {
    super(message);
    this.name = 'UsageSettlementError';
  }
}

/**
 * Wrap an MCP v2 tool handler with usage admission and settlement.
 *
 * Error settlement is conservative by default: the full reservation is charged.
 * Applications may return a lower amount only when they can prove the failure
 * happened before the metered cost was incurred.
 *
 * While a handler is running, the reservation is renewed at roughly one third of
 * its lease TTL. This prevents a legitimate long-running tool from being reclaimed
 * as abandoned during normal operation. The heartbeat can be disabled only when
 * the application provides an equivalent renewal mechanism.
 *
 * Settlement failures are never reclassified as tool-execution failures and are
 * not retried here. A production store may have applied a write even when the
 * caller did not receive an acknowledgement, so retrying settlement blindly can
 * create a second state transition.
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
    const heartbeat = options.leaseHeartbeat === false ? noHeartbeat() : startLeaseHeartbeat(lease);
    let result: TResult;

    try {
      result = await handler(args, ctx);
    } catch (executionError) {
      await heartbeat.stop();
      const actualUnits = options.errorUnits
        ? await options.errorUnits({ error: executionError, args, ctx, lease })
        : lease.reservedUnits;
      await settleOnce(lease, actualUnits, 'error', executionError);
      throw executionError;
    }

    await heartbeat.stop();
    const actualUnits = options.successUnits
      ? await options.successUnits({ result, args, ctx, lease })
      : lease.reservedUnits;
    await settleOnce(lease, actualUnits, 'success');
    return result;
  };
}

interface LeaseHeartbeat {
  stop(): Promise<void>;
}

function noHeartbeat(): LeaseHeartbeat {
  return { stop: async () => undefined };
}

function startLeaseHeartbeat(lease: UsageLease): LeaseHeartbeat {
  const intervalMs = Math.max(1, Math.floor(lease.ttlMs / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped) return;
      inFlight = lease
        .renew()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          inFlight = undefined;
          schedule();
        });
    }, intervalMs);
  };

  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (inFlight !== undefined) await inFlight;
    },
  };
}

async function settleOnce(
  lease: UsageLease,
  actualUnits: number,
  outcome: string,
  executionError?: unknown,
): Promise<void> {
  try {
    await lease.settle(actualUnits, outcome);
  } catch (settlementError) {
    throw new UsageSettlementError(
      'Usage settlement failed; settlement state may be ambiguous',
      settlementError,
      executionError,
    );
  }
}
