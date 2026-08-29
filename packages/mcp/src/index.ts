import type { ServerContext } from '@modelcontextprotocol/server';
import {
  UsageDeniedError,
  UsageStateError,
  type Principal,
  type UsageControl,
  type UsageLease,
  type UsageLeaseResumeState,
} from 'mcp-usage-control';
import { normalizeSettlementOutcome } from 'mcp-usage-control/settlement-outcomes';

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
  /**
   * Best-effort notification that automatic lease renewal became acknowledgement-ambiguous,
   * or that a later renewal confirmed the lease again. The callback is advisory only: it
   * never changes authoritative accounting state and callback failures are ignored.
   */
  onLeaseRenewalState?(event: LeaseRenewalStateEvent): MaybePromise<void>;
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


export type LeaseRenewalStateEvent =
  | { status: 'uncertain'; lease: UsageLease; error: unknown }
  | { status: 'confirmed'; lease: UsageLease };

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

/** Decoded payload expected from the SDK requestState verification hook. */
export interface McpUsageRequestStatePayload {
  mcpUsageControl: 1;
  flowId: string;
}

/**
 * Binding checked atomically before a suspended flow is consumed.
 * The args hash prevents a retry from changing the original tool arguments.
 */
export interface McpUsageFlowBinding {
  principalId: string;
  tenantId?: string;
  tool: string;
  argsHash: string;
}

/** Serializable trusted server-side state for one suspended MCP usage flow. */
export interface McpUsageFlowRecord {
  flowId: string;
  binding: McpUsageFlowBinding;
  lease: UsageLeaseResumeState;
  /** First handler entry is round 0; the first retry is round 1. */
  round: number;
  expiresAt: number;
  /** Original handler-authored requestState, retained server-side rather than trusted from the client. */
  applicationRequestState?: string;
}

/**
 * Server-side suspended-flow storage.
 *
 * `consume()` MUST atomically compare `binding`, reject expired state using the
 * store's authoritative time domain, and remove the flow only when it matches
 * and remains valid. A mismatched or expired caller must receive undefined
 * without consuming a legitimate live flow. A successfully returned record is
 * authoritative proof that suspended-flow expiry passed; callers MUST NOT
 * reinterpret that result using an unrelated application-host clock. This
 * one-time consume prevents concurrent retry re-entry.
 */
export interface McpUsageFlowStore {
  suspend(record: McpUsageFlowRecord): MaybePromise<void>;
  consume(flowId: string, binding: McpUsageFlowBinding): MaybePromise<McpUsageFlowRecord | undefined>;
}

/**
 * Process-local flow store for tests and single-process servers.
 *
 * Instantiate it outside a `createMcpHandler` per-request factory. Distributed
 * or horizontally scaled servers should provide a durable store with atomic
 * compare-and-consume semantics instead.
 */
export class MemoryMcpUsageFlowStore implements McpUsageFlowStore {
  private readonly flows = new Map<string, McpUsageFlowRecord>();

  suspend(record: McpUsageFlowRecord): void {
    this.pruneExpired(Date.now());
    validateFlowRecord(record);
    if (this.flows.has(record.flowId)) {
      throw new UsageStateError('MCP usage flow ID already exists');
    }
    this.flows.set(record.flowId, cloneFlowRecord(record));
  }

  consume(flowId: string, binding: McpUsageFlowBinding): McpUsageFlowRecord | undefined {
    const now = Date.now();
    this.pruneExpired(now);
    const record = this.flows.get(flowId);
    if (!record || record.expiresAt <= now) return undefined;
    if (!sameBinding(record.binding, binding)) return undefined;
    this.flows.delete(flowId);
    return cloneFlowRecord(record);
  }

  private pruneExpired(now: number): void {
    for (const [flowId, record] of this.flows) {
      if (record.expiresAt <= now) this.flows.delete(flowId);
    }
  }
}

export interface McpUsageRequestStateMinter {
  /**
   * Mint an integrity-protected requestState value for the client round-trip.
   * Use the same codec whose `verify` hook is configured on the MCP server.
   */
  mint(payload: McpUsageRequestStatePayload, ctx: ServerContext): MaybePromise<string>;
}

export interface McpUsageFlowContext {
  /** First handler entry is 0; each successful resume increments it by one. */
  readonly round: number;
  /** Stable logical operation ID from the first round. */
  readonly operationId: string;
  /**
   * Handler-authored requestState captured from the prior input_required result.
   * It came from trusted server-side flow storage; the wrapper-owned wire
   * requestState is not exposed here.
   */
  readonly applicationRequestState?: string;
}

export interface ProtectMultiRoundToolOptions<TArgs, TResult>
  extends ProtectToolOptions<TArgs, TResult> {
  flowStore: McpUsageFlowStore;
  requestState: McpUsageRequestStateMinter;
  /** Explicit human/input suspension lease duration. Required to avoid an accidental unbounded hold. */
  suspendTtlMs: number;
  /** Maximum number of resumed rounds. Defaults to 8. */
  maxRounds?: number;
  /** Test/custom ID generator. Defaults to a cryptographically random ID. */
  flowId?: () => MaybePromise<string>;
}

export type NoInputProtectMultiRoundToolOptions<TResult> = ProtectMultiRoundToolOptions<
  undefined,
  TResult
> & { noInput: true };

export type InputProtectMultiRoundToolOptions<TArgs, TResult> = ProtectMultiRoundToolOptions<
  TArgs,
  TResult
> & { noInput?: false };

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

export class McpUsageResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpUsageResumeError';
  }
}

export class McpUsageRoundsExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpUsageRoundsExceededError';
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
 * MCP v2 `input_required` results remain rejected by this single-round wrapper;
 * use `protectMultiRoundTool()` when suspend/resume is required.
 */
export function protectTool<TArgs, TResult>(
  options: ProtectToolOptions<TArgs, TResult>,
  handler: (args: TArgs, ctx: ServerContext) => MaybePromise<TResult>,
): NoInputProtectedToolHandler<TResult> | InputProtectedToolHandler<TArgs, TResult> {
  const protectedHandler = async (
    argsOrCtx: TArgs | ServerContext,
    maybeCtx?: ServerContext,
  ): Promise<TResult> => {
    const { args, ctx } = resolveInvocation(options.noInput === true, argsOrCtx, maybeCtx, 'protectTool');
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

    const heartbeat = options.leaseHeartbeat === false ? noHeartbeat() : startLeaseHeartbeat(lease, options.onLeaseRenewalState);
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
        'MCP input_required requires protectMultiRoundTool(); protectTool() is single-round only',
      );
    }

    return settleCompletedResult(options, result, args, ctx, lease);
  };

  return protectedHandler as
    | NoInputProtectedToolHandler<TResult>
    | InputProtectedToolHandler<TArgs, TResult>;
}

/** No-input-schema multi-round overload. */
export function protectMultiRoundTool<TResult>(
  options: NoInputProtectMultiRoundToolOptions<TResult>,
  handler: (
    args: undefined,
    ctx: ServerContext,
    flow: McpUsageFlowContext,
  ) => MaybePromise<TResult>,
): NoInputProtectedToolHandler<TResult>;

/** Input-schema multi-round overload. */
export function protectMultiRoundTool<TArgs, TResult>(
  options: InputProtectMultiRoundToolOptions<TArgs, TResult>,
  handler: (args: TArgs, ctx: ServerContext, flow: McpUsageFlowContext) => MaybePromise<TResult>,
): InputProtectedToolHandler<TArgs, TResult>;

/**
 * Protect an MCP v2 `input_required` flow without reserving again on retries.
 *
 * The wrapper owns the wire `requestState`. The application handler may still
 * return its own `requestState`; that string is kept only in trusted server-side
 * flow storage and is exposed on the next entry as `flow.applicationRequestState`.
 *
 * On resume, `ctx.mcpReq.requestState<T>()` MUST already contain a decoded object
 * produced by the MCP server's configured verification hook. If the server has
 * no verifier, the SDK returns the raw string and this wrapper fails closed.
 *
 * A flow token is one-time: `flowStore.consume()` must atomically compare the
 * principal/tool/args binding and consume it. Concurrent or replayed resume
 * attempts therefore cannot execute the application handler twice. If a claimed
 * process disappears before producing a next state or settlement, the liable
 * usage lease eventually expires conservatively at its full reserved charge.
 */
export function protectMultiRoundTool<TArgs, TResult>(
  options: ProtectMultiRoundToolOptions<TArgs, TResult>,
  handler: (args: TArgs, ctx: ServerContext, flow: McpUsageFlowContext) => MaybePromise<TResult>,
): NoInputProtectedToolHandler<TResult> | InputProtectedToolHandler<TArgs, TResult> {
  assertPositiveInteger(options.suspendTtlMs, 'suspendTtlMs');
  const maxRounds = options.maxRounds ?? 8;
  assertPositiveInteger(maxRounds, 'maxRounds');

  const protectedHandler = async (
    argsOrCtx: TArgs | ServerContext,
    maybeCtx?: ServerContext,
  ): Promise<TResult> => {
    const { args, ctx } = resolveInvocation(
      options.noInput === true,
      argsOrCtx,
      maybeCtx,
      'protectMultiRoundTool',
    );
    const principal = await options.principal(ctx);
    const argsHash = await hashArgs(args);
    const binding: McpUsageFlowBinding = {
      principalId: principal.id,
      ...(principal.tenantId === undefined ? {} : { tenantId: principal.tenantId }),
      tool: options.tool,
      argsHash,
    };

    const decodedState = ctx.mcpReq.requestState<McpUsageRequestStatePayload>();
    let lease: UsageLease;
    let round: number;
    let operationId: string;
    let applicationRequestState: string | undefined;

    if (decodedState === undefined) {
      operationId = await options.operationId(args, ctx);
      const admission = await options.control.reserve({
        operationId,
        principal,
        tool: options.tool,
        args,
      });
      if (!admission.allowed) throw new UsageDeniedError(admission.reason);
      lease = admission.lease;
      await lease.markLiable();
      round = 0;
    } else {
      if (!isMcpUsageRequestStatePayload(decodedState)) {
        throw new McpUsageResumeError(
          'MCP usage requestState was not a verified decoded resume payload',
        );
      }
      const suspended = await options.flowStore.consume(decodedState.flowId, binding);
      if (!suspended) {
        throw new McpUsageResumeError('MCP usage resume state was missing, expired, replayed, or mismatched');
      }
      if (!sameBinding(suspended.binding, binding)) {
        throw new McpUsageResumeError('MCP usage resume state failed its server-side binding check');
      }
      lease = options.control.resumeLease(suspended.lease);
      operationId = lease.reservation.operationId;
      round = suspended.round;
      applicationRequestState = suspended.applicationRequestState;

      // The UsageStore is authoritative. This renew proves the reservation still
      // exists and extends it before application work resumes.
      await lease.renew(options.suspendTtlMs);
    }

    const flowContext: McpUsageFlowContext = {
      round,
      operationId,
      ...(applicationRequestState === undefined ? {} : { applicationRequestState }),
    };
    const heartbeat = options.leaseHeartbeat === false ? noHeartbeat() : startLeaseHeartbeat(lease, options.onLeaseRenewalState);
    let result: TResult;

    try {
      result = await handler(args, ctx, flowContext);
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

    if (!isInputRequiredResult(result)) {
      return settleCompletedResult(options, result, args, ctx, lease);
    }

    const nextRound = round + 1;
    if (nextRound > maxRounds) {
      await settleOnce(lease, lease.reservedUnits, 'input_required_round_limit');
      throw new McpUsageRoundsExceededError('MCP usage multi-round flow exceeded maxRounds');
    }

    const resultRecord = result as unknown as Record<string, unknown>;
    const innerState = resultRecord.requestState;
    if (innerState !== undefined && typeof innerState !== 'string') {
      await settleOnce(lease, lease.reservedUnits, 'invalid_input_required_state');
      throw new McpUsageResumeError('MCP input_required requestState must be a string when present');
    }

    let wrappedResult: TResult;
    try {
      const flowId = await createFlowId(options.flowId);
      const requestState = await options.requestState.mint(
        { mcpUsageControl: 1, flowId },
        ctx,
      );
      validateWireRequestState(requestState);
      const renewed = await lease.renew(options.suspendTtlMs);
      const record: McpUsageFlowRecord = {
        flowId,
        binding,
        lease: lease.toResumeState(),
        round: nextRound,
        expiresAt: renewed.expiresAt,
        ...(innerState === undefined ? {} : { applicationRequestState: innerState }),
      };
      await options.flowStore.suspend(record);
      wrappedResult = { ...resultRecord, requestState } as TResult;
    } catch (suspendError) {
      await settleOnce(lease, lease.reservedUnits, 'input_required_suspend_failed', suspendError);
      throw suspendError;
    }

    return wrappedResult;
  };

  return protectedHandler as
    | NoInputProtectedToolHandler<TResult>
    | InputProtectedToolHandler<TArgs, TResult>;
}

async function settleCompletedResult<TArgs, TResult>(
  options: ProtectToolOptions<TArgs, TResult>,
  result: TResult,
  args: TArgs,
  ctx: ServerContext,
  lease: UsageLease,
): Promise<TResult> {
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
}

function resolveInvocation<TArgs>(
  noInput: boolean,
  argsOrCtx: TArgs | ServerContext,
  maybeCtx: ServerContext | undefined,
  wrapperName: string,
): { args: TArgs; ctx: ServerContext } {
  if (noInput) {
    return {
      args: undefined as TArgs,
      ctx: (maybeCtx ?? argsOrCtx) as ServerContext,
    };
  }
  if (maybeCtx === undefined) {
    throw new TypeError(
      `${wrapperName} expected an (args, ctx) invocation; set noInput: true for a tool without an input schema`,
    );
  }
  return { args: argsOrCtx as TArgs, ctx: maybeCtx };
}

const MAX_PORTABLE_TIMER_DELAY_MS = 2_147_483_647;

interface LeaseHeartbeat {
  stop(): Promise<void>;
}

function noHeartbeat(): LeaseHeartbeat {
  return { stop: async () => undefined };
}

function startLeaseHeartbeat(
  lease: UsageLease,
  onState?: (event: LeaseRenewalStateEvent) => MaybePromise<void>,
): LeaseHeartbeat {
  const intervalMs = Math.max(1, Math.floor(lease.ttlMs / 3));
  let remainingMs = intervalMs;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let uncertain = false;

  const notify = (event: LeaseRenewalStateEvent): void => {
    if (!onState) return;
    Promise.resolve()
      .then(() => onState(event))
      .catch(() => undefined);
  };

  const schedule = (): void => {
    if (stopped) return;
    const delayMs = Math.min(remainingMs, MAX_PORTABLE_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      if (stopped) return;
      remainingMs -= delayMs;
      if (remainingMs > 0) {
        schedule();
        return;
      }
      inFlight = lease
        .renew()
        .then(() => {
          if (uncertain) {
            uncertain = false;
            notify({ status: 'confirmed', lease });
          }
        })
        .catch(error => {
          if (!uncertain) {
            uncertain = true;
            notify({ status: 'uncertain', lease, error });
          }
        })
        .finally(() => {
          inFlight = undefined;
          remainingMs = intervalMs;
          schedule();
        });
    }, delayMs);
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

function isMcpUsageRequestStatePayload(value: unknown): value is McpUsageRequestStatePayload {
  return (
    isRecord(value) &&
    value.mcpUsageControl === 1 &&
    typeof value.flowId === 'string' &&
    isValidFlowId(value.flowId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function settleOnce(
  lease: UsageLease,
  actualUnits: number,
  outcome: string,
  executionError?: unknown,
): Promise<void> {
  try {
    const canonicalOutcome = normalizeSettlementOutcome(outcome);
    await lease.settle(actualUnits, canonicalOutcome);
  } catch (settlementError) {
    throw new UsageSettlementError(
      'Usage settlement failed; settlement state may be ambiguous',
      settlementError,
      executionError,
    );
  }
}

async function createFlowId(generator: (() => MaybePromise<string>) | undefined): Promise<string> {
  const flowId = generator ? await generator() : randomFlowId();
  if (!isValidFlowId(flowId)) {
    throw new RangeError('flowId must be 16-128 URL-safe characters');
  }
  return flowId;
}

function randomFlowId(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function isValidFlowId(value: string): boolean {
  return /^[A-Za-z0-9._~-]{16,128}$/.test(value);
}

function validateWireRequestState(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) {
    throw new RangeError('minted MCP requestState must be a non-empty string up to 16384 characters');
  }
}

async function hashArgs(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(stableJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function stableJson(value: unknown, seen: Set<object> = new Set()): string {
  if (value === undefined) return '["undefined"]';
  if (value === null) return '["null"]';
  switch (typeof value) {
    case 'string':
      return `["string",${JSON.stringify(value)}]`;
    case 'boolean':
      return `["boolean",${value ? 'true' : 'false'}]`;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('MCP tool args must contain only finite JSON numbers');
      return `["number",${JSON.stringify(value)}]`;
    case 'object': {
      const object = value as object;
      if (seen.has(object)) throw new TypeError('MCP tool args must not contain cycles');
      seen.add(object);
      try {
        if (Array.isArray(value)) {
          return `["array",${value.map(item => stableJson(item, seen)).join(',')}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError('MCP tool args must be plain JSON objects');
        }
        const entries = Object.keys(value as Record<string, unknown>)
          .sort()
          .map(
            key =>
              `[${JSON.stringify(key)},${stableJson((value as Record<string, unknown>)[key], seen)}]`,
          );
        return `["object",${entries.join(',')}]`;
      } finally {
        seen.delete(object);
      }
    }
    default:
      throw new TypeError('MCP tool args must be JSON-serializable');
  }
}

function sameBinding(left: McpUsageFlowBinding, right: McpUsageFlowBinding): boolean {
  return (
    left.principalId === right.principalId &&
    left.tenantId === right.tenantId &&
    left.tool === right.tool &&
    left.argsHash === right.argsHash
  );
}

function validateFlowRecord(record: McpUsageFlowRecord): void {
  if (!isValidFlowId(record.flowId)) throw new UsageStateError('Invalid MCP usage flow ID');
  if (!Number.isSafeInteger(record.round) || record.round <= 0) {
    throw new UsageStateError('MCP usage flow round must be a positive safe integer');
  }
  if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= Date.now()) {
    throw new UsageStateError('MCP usage flow expiry must be in the future');
  }
  if (record.lease.reservation.expiresAt !== record.expiresAt) {
    throw new UsageStateError('MCP usage flow and lease expiry must match');
  }
  if (record.binding.principalId.length === 0 || record.binding.tool.length === 0) {
    throw new UsageStateError('MCP usage flow binding identity must be non-empty');
  }
  if (!/^[a-f0-9]{64}$/.test(record.binding.argsHash)) {
    throw new UsageStateError('MCP usage flow args hash must be SHA-256 hex');
  }
  if (
    record.applicationRequestState !== undefined &&
    (record.applicationRequestState.length === 0 || record.applicationRequestState.length > 16_384)
  ) {
    throw new UsageStateError('Application requestState must be a non-empty bounded string');
  }
}

function cloneFlowRecord(record: McpUsageFlowRecord): McpUsageFlowRecord {
  return {
    flowId: record.flowId,
    binding: { ...record.binding },
    lease: {
      reservation: {
        ...record.lease.reservation,
        budgetKeys: [...record.lease.reservation.budgetKeys],
      },
      ttlMs: record.lease.ttlMs,
      ...(record.lease.metadata === undefined ? {} : { metadata: { ...record.lease.metadata } }),
      ...(record.lease.unresolvedGrowth === undefined
        ? {}
        : {
            unresolvedGrowth: {
              incrementId: record.lease.unresolvedGrowth.incrementId,
              additionalUnits: record.lease.unresolvedGrowth.additionalUnits,
              budgets: record.lease.unresolvedGrowth.budgets.map(budget => ({ ...budget })),
            },
          }),
    },
    round: record.round,
    expiresAt: record.expiresAt,
    ...(record.applicationRequestState === undefined
      ? {}
      : { applicationRequestState: record.applicationRequestState }),
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
