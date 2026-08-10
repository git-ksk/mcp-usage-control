# API reference

[English](api-reference.md) | [日本語](api-reference.ja.md)

> Pre-alpha: this reference describes the current development API. Names and signatures may change before v0.1.

## `@mcp-usage-control/core`

### `Principal`

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

Accounting identity supplied by the application. It is not an authentication primitive.

### `UsageRequest<TArgs>`

```ts
interface UsageRequest<TArgs = unknown> {
  operationId: string;
  principal: Principal;
  tool: string;
  args: TArgs;
}
```

One logical usage-controlled invocation. `operationId` is used for duplicate protection and should be stable across retries of the same logical invocation.

### `Budget`

```ts
interface Budget {
  key: string;
  limit: number;
}
```

A policy-defined accounting bucket. Use explicit window-qualified keys for time windows.

### `UsageQuote` / `UsagePolicy`

```ts
type UsageQuote =
  | {
      decision: 'allow';
      units: number;
      budget: Budget;
      reservationTtlMs?: number;
    }
  | { decision: 'deny'; reason: string };

interface UsagePolicy {
  quote(request: UsageRequest): UsageQuote | Promise<UsageQuote>;
}
```

### `UsageStore`

```ts
interface UsageStore {
  reserve(input: {
    request: UsageRequest;
    units: number;
    budget: Budget;
    ttlMs: number;
  }): Promise<StoreReserveResult>;

  markLiable(input: MarkLiableInput): Promise<MarkLiableResult>;
  renew(input: RenewInput): Promise<RenewResult>;
  settle(input: SettleInput): Promise<SettlementResult>;
}
```

Production implementations must preserve the atomicity and failure invariants in [Architecture](architecture.md).

### `UsageControl`

```ts
new UsageControl(store, policy, defaultReservationTtlMs?);
```

Default reservation TTL is 60,000 ms. `reserve(request)` evaluates policy, validates the quote, asks the store for atomic admission, and returns an `AdmissionResult`.

### `AdmissionResult`

```ts
type AdmissionResult =
  | { allowed: true; lease: UsageLease }
  | { allowed: false; reason: string; remaining?: number };
```

Built-in store denial reasons currently include `quota_exceeded` and `duplicate_operation`; a policy may provide its own denial reason.

### `UsageLease`

```ts
lease.reservation
lease.ttlMs
lease.reservedUnits
await lease.markLiable()
await lease.renew(ttlMs?)
await lease.settle(actualUnits, outcome)
```

`markLiable()` declares that the metered execution boundary has been entered. If that active lease later expires before settlement, production stores should conservatively retain the reservation as consumed rather than refunding it.

`renew()` extends an active lease. `settle()` finalizes actual usage. The current contract requires `actualUnits <= reservedUnits`.

### `ReservationRecord`

```ts
interface ReservationRecord {
  id: string;
  operationId: string;
  principalId: string;
  tool: string;
  budgetKey: string;
  reservedUnits: number;
  expiresAt: number;
}
```

### `SettlementResult`

```ts
interface SettlementResult {
  reservationId: string;
  reservedUnits: number;
  actualUnits: number;
  releasedUnits: number;
  outcome: string;
}
```

### Errors

`UsageStateError` indicates an invalid, expired, or conflicting store state.

`UsageDeniedError` exposes a programmatic `.reason`, but its thrown message is intentionally generic (`Usage denied by usage policy`) so internal policy details are not automatically surfaced by MCP SDK error conversion.

### `MemoryUsageStore`

Reference implementation for tests and local development. It supports pending/cost-liable/settled lifecycle behavior but is process-local and is not a production distributed store.

## `@mcp-usage-control/mcp`

### `protectTool(options, handler)`

Wraps a **single-round** `@modelcontextprotocol/server` v2 tool handler with reserve, cost-liable activation, heartbeat, execution classification, and settlement.

```ts
interface ProtectToolOptions<TArgs, TResult> {
  control: UsageControl;
  tool: string;
  principal(ctx: ServerContext): Principal | Promise<Principal>;
  operationId(args: TArgs, ctx: ServerContext): string | Promise<string>;
  leaseHeartbeat?: boolean;
  successUnits?(input: {
    result: TResult;
    args: TArgs;
    ctx: ServerContext;
    lease: UsageLease;
  }): number | Promise<number>;
  toolErrorUnits?(input: {
    result: TResult;
    args: TArgs;
    ctx: ServerContext;
    lease: UsageLease;
  }): number | Promise<number>;
  errorUnits?(input: {
    error: unknown;
    args: TArgs;
    ctx: ServerContext;
    lease: UsageLease;
  }): number | Promise<number>;
}
```

The wrapped application handler uses the adapter-level shape `(args, ctx)`. For an SDK tool with no input schema, `protectTool()` normalizes the SDK's native `(ctx)` invocation and passes `undefined` as `args` to the operation-ID hook, cost hooks, policy request, and wrapped handler.

### `ProtectedToolHandler<TArgs, TResult>`

The function returned by `protectTool()` accepts both MCP SDK v2 callback forms:

```ts
interface ProtectedToolHandler<TArgs, TResult> {
  (ctx: ServerContext): Promise<TResult>;
  (args: TArgs, ctx: ServerContext): Promise<TResult>;
}
```

This exists because the SDK invokes no-input-schema tools as `(ctx)` and tools with an input schema as `(args, ctx)`.

Behavior:

- admitted leases are marked cost-liable before entering the handler;
- `leaseHeartbeat` defaults to enabled;
- normal successes use `successUnits` or the full reservation;
- MCP `{ isError: true }` results use `toolErrorUnits` or the full reservation;
- thrown errors use `errorUnits` or the full reservation;
- invalid/throwing cost classifiers cause a conservative full settlement followed by `UsageClassificationError`;
- admission denial throws `UsageDeniedError` before handler execution;
- settlement failure throws `UsageSettlementError` and is not blindly retried;
- `resultType: 'input_required'` is currently unsupported and produces `UnsupportedMcpUsageFlowError` after conservative settlement.

See [MCP integration](mcp-integration.md).

### `UsageSettlementError`

```ts
settlementError: unknown
executionError?: unknown
```

Represents an ambiguous or failed accounting settlement.

### `UsageClassificationError`

```ts
classificationError: unknown
executionError?: unknown
```

Raised after the wrapper has conservatively settled the full reservation because a cost classifier failed or returned invalid units.

### `UnsupportedMcpUsageFlowError`

Currently used for MCP v2 `input_required` multi-round tool results. Suspend/resume accounting is not yet implemented.

## `@mcp-usage-control/redis`

### `RedisUsageStore`

```ts
new RedisUsageStore(client, options?);
```

The client needs an `eval(script, { keys, arguments })` method compatible with `RedisEvalClient`.

### `RedisUsageStoreOptions`

```ts
interface RedisUsageStoreOptions {
  prefix?: string;
  hashTag?: string;
  cleanupBatchSize?: number;
  idempotencyTtlMs?: number;
}
```

Defaults:

- `prefix`: `muc`
- `hashTag`: `usage`
- `cleanupBatchSize`: `256`
- `idempotencyTtlMs`: `86_400_000` (24 hours)

Lease and tombstone timestamps are calculated from Redis server time inside Lua, not from the application clock. See [Redis adapter](redis.md) for key layout, cleanup, cost-liable expiry, acknowledgement ambiguity, durability boundaries, and Redis Cluster trade-offs.

## Numeric validation

Units and limits are JavaScript safe integers. Units/limits must be non-negative; TTL and retention durations must be positive safe integers where accepted. Classifier results must also be `<= reservedUnits`.

## Compatibility

Current repository targets:

- Node.js 20+
- `@modelcontextprotocol/server` v2, currently built/tested against 2.0.0
- Redis 7 integration behavior
- node-redis `redis` 6.2.x in the workspace

These are pre-alpha compatibility targets, not yet a long-term support promise.