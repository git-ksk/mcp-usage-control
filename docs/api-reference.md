# API reference

[English](api-reference.md) | [日本語](api-reference.ja.md)

> Pre-alpha: this reference describes the current `main` API. Names and signatures may change before v0.1.

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

### `UsageQuote`

```ts
type UsageQuote =
  | {
      decision: 'allow';
      units: number;
      budget: Budget;
      reservationTtlMs?: number;
    }
  | {
      decision: 'deny';
      reason: string;
    };
```

Policy output. Allowed quotes reserve `units` before execution. `reservationTtlMs` overrides the `UsageControl` default for that request.

### `UsagePolicy`

```ts
interface UsagePolicy {
  quote(request: UsageRequest): UsageQuote | Promise<UsageQuote>;
}
```

Application-defined admission/quoting policy.

### `UsageStore`

```ts
interface UsageStore {
  reserve(input: {
    request: UsageRequest;
    units: number;
    budget: Budget;
    ttlMs: number;
  }): Promise<StoreReserveResult>;

  renew(input: RenewInput): Promise<RenewResult>;
  settle(input: SettleInput): Promise<SettlementResult>;
}
```

Storage contract. Production implementations must preserve the atomicity and failure invariants in [Architecture](architecture.md).

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

Store-level built-in denial reasons currently include `quota_exceeded` and `duplicate_operation`; a policy may provide its own denial reason.

### `UsageLease`

Important members:

```ts
lease.reservation
lease.ttlMs
lease.reservedUnits
await lease.renew(ttlMs?)
await lease.settle(actualUnits, outcome)
```

`renew()` extends a pending lease. `settle()` finalizes actual usage. The current store contract requires `actualUnits <= reservedUnits`.

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

Represents an admitted pending reservation as seen by the caller.

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

`UsageStateError` indicates an invalid or conflicting store state, such as an expired reservation or conflicting settlement replay.

`UsageDeniedError` wraps a denial reason for adapters that expose admission failure as an exception.

### `MemoryUsageStore`

Reference `UsageStore` implementation for tests and local development. It is process-local and is not a production distributed store.

## `@mcp-usage-control/mcp`

### `protectTool(options, handler)`

Wraps an `@modelcontextprotocol/server` v2 tool handler with reserve, optional heartbeat, execution, and settlement behavior.

```ts
interface ProtectToolOptions<TArgs, TResult> {
  control: UsageControl;
  tool: string;
  principal(ctx: ServerContext): Principal | Promise<Principal>;
  operationId(
    args: TArgs,
    ctx: ServerContext,
  ): string | Promise<string>;
  leaseHeartbeat?: boolean;
  successUnits?(input: {
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

Behavior:

- `leaseHeartbeat` defaults to enabled;
- successful handlers settle the full reservation unless `successUnits` is provided;
- failed handlers settle the full reservation unless `errorUnits` is provided;
- admission denial throws `UsageDeniedError` before handler execution;
- settlement failure throws `UsageSettlementError` and is not blindly retried.

See [MCP integration](mcp-integration.md) for usage and safety notes.

### `UsageSettlementError`

Contains:

```ts
settlementError: unknown
executionError?: unknown
```

When settlement fails after a tool error, `executionError` preserves the original execution failure while `settlementError` describes the accounting failure.

## `@mcp-usage-control/redis`

### `RedisUsageStore`

```ts
new RedisUsageStore(client, options?);
```

The client needs an `eval(script, { keys, arguments })` method compatible with the adapter's `RedisEvalClient` interface.

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

`prefix` and `hashTag` reject Redis hash-tag braces so the adapter controls its transaction domain.

See [Redis adapter](redis.md) for key layout, cleanup, acknowledgement ambiguity, and Redis Cluster trade-offs.

## Numeric validation

Units and limits are represented as JavaScript safe integers. Units/limits must be non-negative; TTL values and cleanup/retention durations must be positive safe integers where accepted.

## Compatibility

Current repository targets:

- Node.js 20+
- `@modelcontextprotocol/server` v2, currently built against 2.0.0
- Redis 7 integration behavior
- node-redis `redis` 6.2.x in the workspace

These are pre-alpha compatibility targets, not yet a long-term support promise.