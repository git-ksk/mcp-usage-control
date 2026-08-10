import type { ServerContext } from '@modelcontextprotocol/server';
import {
  UsageDeniedError,
  type Principal,
  type UsageControl,
  type UsageLease,
} from 'mcp-usage-control';

type MaybePromise<T> = T | Promise<T>;

export interface ProtectToolOptions<TArgs, TResult> {
  control: UsageControl;
  tool: string;
  /**
   * Set to true when the MCP tool has no input schema.
   *
   * The SDK's TypeScript callback type is `(ctx)` for no-input tools, while
   * some server dispatch paths invoke the callback at runtime as `({}, ctx)`.
   * An empty object is indistinguishable from valid args for an empty input
   * schema, so this adapter requires an explicit mode instead of guessing.
   */
  noInput?: boolean;
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
  toolErrorUnits?(input: {
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

export type NoInputProtectToolOptions<TResult> = ProtectToolOptions<undefined, TResult> & {
  noInput: true;
};

export type InputProtectToolOptions<TArgs, TResult> = ProtectToolOptions<TArgs, TResult> & {
  noInput?: false;
};

export type NoInputProtectedToolHandler<TResult> = (ctx: ServerContext) => Promise<TResult>;
export type InputProtectedToolHandler<TArgs, TResult> = (
  args: TArgs,
  ctx: ServerContext,
) => Promise<TResult>;

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

export class UsageClassificationError extends Error {
  constructor(
    message: string,
    public readonly classificationError: unknown,
    public readonly executionError?: unknown,
  ) {
    super(message);
    this.name = 'UsageClassificationError';
  }
}

export class UnsupportedMcpUsageFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMcpUsageFlowError';
  }
}

/** No-input-schema overload. `noInput: true` is required. */
export function protectTool<TResult>(
  options: NoInputProtectToolOptions<TResult>,
  handler: (args: undefined, ctx: ServerContext) => MaybePromise<TResult>,
): NoInputProtectedToolHandler<TResult>;

/** Input-schema overload. `noInput` must be omitted or false. */
export function protectTool<TArgs, TResult>(
  options: InputProtectToolOptions<TArgs, TResult>,
  handler: (args: TArgs, ctx: ServerContext) => MaybePromise<TResult>,
): InputProtectedToolHandler<TArgs, TResult>;

/**
 * Wrap an MCP v2 single-round tool handler with usage admission and settlement.
 *
 * The lease is marked cost-liable immediately before the application handler is
 * entered. If the process disappears after that point, expiry conservatively
 * charges the full reservation instead of turning a crash into a refund.
 *
 * Error settlement is conservative by default: the full reservation is charged.
 * Applications may return a lower amount only when they can prove the metered
 * cost was not incurred. If a cost-classification hook throws or returns an
 * invalid amount, the wrapper charges the full reservation before surfacing a
 * UsageClassificationError.
 *
 * MCP `isError: true` results are classified as tool errors rather than success.
 * MCP v2 `input_required` multi-round-trip results are intentionally rejected in
 * v0.1 because correct suspend/resume accounting requires a dedicated
 * reservation-resume contract. The reservation is conservatively settled before
 * the unsupported-flow error is surfaced.
 */
export function protectTool<TArgs, TResult>(
  options: ProtectToolOptions<TArgs, TResult>,
  handler: (args: TArgs, ctx: ServerContext) => MaybePromise<TResult>,
): NoInputProtectedToolHandler<TResult> | InputProtectedToolHandler<TArgs, TResult> {
  const protectedHandler = async (
    argsOrCtx: TArgs | ServerContext,
    maybeCtx?: ServerContext,
  ): Promise<TResult> => {
    let args: TArgs;
    let ctx: ServerContext;

    if (options.noInput === true) {
      args = undefined as TArgs;
      ctx = (maybeCtx ?? argsOrCtx) as ServerContext;
    } else {
      if (maybeCtx === undefined) {
        throw new TypeError(
          'protectTool expected an (args, ctx) invocation; set noInput: true for a tool without an input schema',
        );
      }
      args = argsOrCtx as TArgs;
      ctx = maybeCtx;
    }

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
    await lease.markLiable();

    const heartbeat = options.leaseHeartbeat === false ? noHeartbeat() : startLeaseHeartbeat(lease);
    let result: TResult;

    try {
      result = await handler(args, ctx);
    } catch (executionError) {
      await heartbeat.stop();
      const classified = await classifyUnits(
        options.errorUnits
          ? () => options.errorUnits!({ error: executionError, args, ctx, lease })
          : undefined,
        lease.reservedUnits,
        lease,
      );
      await settleOnce(lease, classified.units, 'error', executionError);
      if (classified.error !== undefined) {
        throw new UsageClassificationError(
          'Usage error-cost classification failed; full reservation was charged',
          classified.error,
          executionError,
        );
      }
      throw executionError;
    }

    await heartbeat.stop();

    if (isInputRequiredResult(result)) {
      await settleOnce(lease, lease.reservedUnits, 'unsupported_input_required');
      throw new UnsupportedMcpUsageFlowError(
        'MCP input_required multi-round tool flows are not supported by protectTool() in v0.1',
      );
    }

    if (isToolErrorResult(result)) {
      const classified = await classifyUnits(
        options.toolErrorUnits
          ? () => options.toolErrorUnits!({ result, args, ctx, lease })
          : undefined,
        lease.reservedUnits,
        lease,
      );
      await settleOnce(lease, classified.units, 'tool_error');
      if (classified.error !== undefined) {
        throw new UsageClassificationError(
          'Usage tool-error classification failed; full reservation was charged',
          classified.error,
        );
      }
      return result;
    }

    const classified = await classifyUnits(
      options.successUnits
        ? () => options.successUnits!({ result, args, ctx, lease })
        : undefined,
      lease.reservedUnits,
      lease,
    );
    await settleOnce(lease, classified.units, 'success');
    if (classified.error !== undefined) {
      throw new UsageClassificationError(
        'Usage success-cost classification failed; full reservation was charged',
        classified.error,
      );
    }
    return result;
  };

  return protectedHandler as
    | NoInputProtectedToolHandler<TResult>
    | InputProtectedToolHandler<TArgs, TResult>;
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

async function classifyUnits(
  resolver: (() => MaybePromise<number>) | undefined,
  fallbackUnits: number,
  lease: UsageLease,
): Promise<{ units: number; error?: unknown }> {
  if (!resolver) return { units: fallbackUnits };
  try {
    const units = await resolver();
    if (!Number.isSafeInteger(units) || units < 0 || units > lease.reservedUnits) {
      throw new RangeError('classified units must be a non-negative safe integer within the reservation');
    }
    return { units };
  } catch (error) {
    return { units: fallbackUnits, error };
  }
}

function isToolErrorResult(value: unknown): boolean {
  return isRecord(value) && value.isError === true;
}

function isInputRequiredResult(value: unknown): boolean {
  return isRecord(value) && value.resultType === 'input_required';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
