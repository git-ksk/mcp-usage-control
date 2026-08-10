# API reference — v0.1

[English](api-reference.md) | [日本語](api-reference.ja.md)

## `mcp-usage-control`

### `Principal`

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

Trusted accounting identity supplied by the application. It is not an authentication primitive.

### `UsageRequest<TArgs>`

```ts
interface UsageRequest<TArgs = unknown> {
  operationId: string;
  principal: Principal;
  tool: string;
  args: TArgs;
}
```

Replay protection is scoped by `(tenantId, principal.id, tool, operationId)`. Use a stable `operationId` across retries of one logical invocation.

### `Budget`

```ts
interface Budget {
  key: string;
  limit: number;
}
```

A policy-defined accounting bucket. Keys must be non-empty strings. Limits are non-negative safe integers. For daily/monthly windows, encode the window explicitly into the key.

### `UsageQuote` / `UsagePolicy`

```ts
type UsageQuote =
  | {
      decision: 'allow';
      units: number;
      budgets: readonly Budget[];
      reservationTtlMs?: number;
    }
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

`budgets` is the v0.1 multi-budget form. Admission reserves the same quoted units against every listed budget atomically. The one-budget `budget` form is a convenience alias. Empty lists and duplicate budget keys are rejected.

### `UsageStore`

```ts
interface UsageStore {
  reserve(input: {
    request: UsageRequest;
    units: number;
    budgets: readonly Budget[];
    ttlMs: number;
  }): Promise<StoreReserveResult>;

  markLiable(input: MarkLiableInput): Promise<MarkLiableResult>;
  renew(input: RenewInput): Promise<RenewResult>;
  settle(input: SettleInput): Promise<SettlementResult>;
}
```

Production implementations must make multi-budget admission all-or-nothing and preserve the lifecycle/failure invariants in [Architecture](architecture.md).

### `UsageControl`

```ts
new UsageControl(store, policy, defaultReservationTtlMs?);
```

Default reservation TTL: `60_000` ms.

`reserve(request)` evaluates policy, validates/canonicalizes budgets, and calls the store for atomic admission.

### `AdmissionResult`

```ts
type AdmissionResult =
  | { allowed: true; lease: UsageLease }
  | {
      allowed: false;
      reason: string;
      limitingBudgetKey?: string;
      remaining?: number;
    };
```

Store denial reasons are `quota_exceeded` and `duplicate_operation`. `quota_exceeded` can identify the limiting budget and its remaining units. Policy denials use the policy-provided reason.

### `ReservationRecord`

```ts
interface ReservationRecord {
  id: string;
  operationId: string;
  principalId: string;
  tenantId?: string;
  tool: string;
  budgetKeys: string[];
  reservedUnits: number;
  expiresAt: number;
}
```

### `UsageLease`

```ts
lease.reservation
lease.ttlMs
lease.reservedUnits
await lease.markLiable()
await lease.renew(ttlMs?)
await lease.settle(actualUnits, outcome)
```

`markLiable()` declares entry into the metered execution boundary. Pending expiry can release reservation capacity; cost-liable expiry conservatively retains the full charge.

`renew()` extends an active lease. `settle()` finalizes the same actual unit count across all budgets participating in the reservation. v0.1 requires `actualUnits <= reservedUnits`.

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

Identical settlement replay is idempotent during tombstone retention. A conflicting actual-unit/outcome replay fails.

### `MemoryUsageStore`

```ts
new MemoryUsageStore({ idempotencyTtlMs? })
```

Process-local reference store for tests and development. Default settled replay tombstone retention: `86_400_000` ms (24 hours).

Pending expired operations release all participating budgets and become reusable. Cost-liable expiry consumes the full reservation and leaves a bounded settled tombstone.

### Core errors

- `UsageStateError` — invalid/expired/conflicting store state.
- `UsageDeniedError` — programmatic `.reason`; generic thrown message to avoid accidental disclosure through MCP SDK error conversion.

## `mcp-usage-control-mcp`

### `ProtectToolOptions<TArgs, TResult>`

Important fields:

```ts
interface ProtectToolOptions<TArgs, TResult> {
  control: UsageControl;
  tool: string;
  noInput?: boolean;
  principal(ctx: ServerContext): Principal | Promise<Principal>;
  operationId(args: TArgs, ctx: ServerContext): string | Promise<string>;
  leaseHeartbeat?: boolean;
  successUnits?(...): number | Promise<number>;
  toolErrorUnits?(...): number | Promise<number>;
  errorUnits?(...): number | Promise<number>;
}
```

For tools with no input schema, `noInput: true` is required. For input-schema tools, omit it or use false. In no-input mode the wrapper normalizes both the SDK public `(ctx)` callback shape and the observed runtime `({}, ctx)` dispatch to `args === undefined` for policy/hooks/application handler.

### `protectTool(options, handler)`

Wraps a **single-round** MCP TypeScript SDK v2 tool handler with admission and settlement.

Behavior:

- reserve before the handler;
- `markLiable()` immediately before application handler entry;
- heartbeat enabled by default while the handler runs;
- normal result -> `successUnits` or full reservation;
- `{ isError: true }` -> `toolErrorUnits` or full reservation;
- thrown exception -> `errorUnits` or full reservation;
- invalid/throwing classifier -> full conservative settlement, then `UsageClassificationError`;
- settlement failure -> `UsageSettlementError`, without blind retry;
- `resultType: 'input_required'` -> conservative settlement, then `UnsupportedMcpUsageFlowError`.

v0.1 does not claim multi-round `input_required` support. See [MCP integration](mcp-integration.md) and issue #14.

### MCP adapter errors

- `UsageSettlementError` — includes `settlementError` and optional `executionError`.
- `UsageClassificationError` — includes `classificationError` and optional `executionError`.
- `UnsupportedMcpUsageFlowError` — v0.1 support-boundary error for multi-round `input_required` results.

## `mcp-usage-control-redis`

### `RedisUsageStore`

```ts
new RedisUsageStore(client, options?)
```

The client must provide an `eval(script, { keys, arguments })` method compatible with `RedisEvalClient`.

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

The v0.1 Redis store uses one transaction domain containing a used-budget hash, a global lease expiry index, reservation records, operation mappings, and tombstones. Budget IDs and operation identities are hashed before storage identifiers are created.

Lua obtains Redis server `TIME` for lease and tombstone decisions. Multi-budget reserve, release, expiry recovery, renew and settlement do not loop single-budget operations client-side.

See [Redis adapter](redis.md) for durability and Redis Cluster constraints.

## Numeric validation

- units and limits: non-negative JavaScript safe integers;
- TTL/retention durations: positive safe integers;
- settlement/classifier result: non-negative safe integer and `<= reservedUnits`.

## Compatibility for v0.1

- Node.js 20+
- ESM packages
- `@modelcontextprotocol/server` v2; CI currently resolves `2.0.0`
- Redis 7 integration tests
- node-redis `redis` 6.2.x

Pre-1.0 minor releases may intentionally change APIs; breaking changes are called out in release notes.
