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

### `UsageObserver` / `UsageEvent`

```ts
interface UsageObserverHandler {
  onEvent(event: UsageEvent): void | Promise<void>;
}

type UsageObserver = UsageObserverHandler | undefined;
```

The v0.1 event union contains:

- `reserve.accepted`
- `reserve.denied`
- `settlement.completed`
- `reservation.recovered`
- `operation.error`

Observer delivery is best-effort and outside the enforcement outcome. `onEvent()` is invoked inline, but a returned promise is not awaited. Keep synchronous callback work lightweight and offload network/durable I/O. Synchronous observer throws and asynchronous promise rejections are swallowed and never change admission/settlement state. Tool arguments and raw exception messages are not captured automatically.

`UsageEventMetadata` is an explicit opt-in `Record<string, string | number | boolean | null>`.

See [Observability](observability.md) for event fields, privacy/cardinality guidance, replay deduplication, Redis aggregate recovery behavior, and delivery guarantees.

### `UsageControl`

```ts
new UsageControl(store, policy, defaultReservationTtlMs?);

new UsageControl(store, policy, {
  defaultReservationTtlMs?: number;
  observer?: UsageObserver;
  metadata?: UsageEventMetadata |
    ((request: UsageRequest) => UsageEventMetadata | undefined);
});
```

Default reservation TTL: `60_000` ms. The numeric third-argument form remains source-compatible.

`reserve(request)` evaluates policy, validates/canonicalizes budgets, calls the store for atomic admission, and emits configured runtime lifecycle events. A metadata callback is explicit opt-in and its failure is ignored rather than affecting enforcement.

`resumeLease(state)` reattaches to an already-reserved lease without calling `policy.quote()` or `store.reserve()` again. It accepts only trusted server-side `UsageLeaseResumeState`; the next renew/settle still uses the underlying store as the authoritative state check.

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

Store denial reasons are `quota_exceeded` and `duplicate_operation`. `quota_exceeded` can identify the limiting budget and its remaining units. Policy denials use the policy-provided reason. Because policy denial reasons can be emitted to observers, applications should use bounded non-secret reason codes rather than free-form diagnostic text.

### `ReservationRecord`

```ts
interface ReservationRecord {
  id: string;
  operationId: string;
  principalId: string;
  tenantId?: string;
  plan?: string;
  tool: string;
  budgetKeys: string[];
  reservedUnits: number;
  expiresAt: number;
}
```

### `UsageLeaseResumeState`

```ts
interface UsageLeaseResumeState {
  reservation: ReservationRecord;
  ttlMs: number;
  metadata?: UsageEventMetadata;
}
```

Serializable state for a trusted server-side suspend/resume workflow. It is not a client credential. Do not expose the raw structure to an untrusted client; use an integrity-protected opaque reference and retain the actual lease state server-side.

### `UsageLease`

```ts
lease.reservation
lease.ttlMs
lease.reservedUnits
lease.toResumeState()
await lease.markLiable()
await lease.renew(ttlMs?)
await lease.settle(actualUnits, outcome)
```

`markLiable()` declares entry into the metered execution boundary. Pending expiry can release reservation capacity; cost-liable expiry conservatively retains the full charge.

`renew()` extends an active lease. `settle()` finalizes the same actual unit count across all budgets participating in the reservation. v0.1 requires `actualUnits <= reservedUnits`.

`toResumeState()` returns a detached snapshot suitable for trusted server-side flow storage. Reattach it with `UsageControl.resumeLease()`; doing so does not quote or reserve a second time.

When configured through `UsageControl`, lease errors and successful settlement emit observer events. Observer failure never changes the lease result.

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

Identical settlement replay is idempotent during tombstone retention. A conflicting actual-unit/outcome replay fails. Calling an identical idempotent settlement again can emit another identical `settlement.completed` event; downstream consumers that require de-duplication can key on `(reservationId, actualUnits, outcome)`. Observability is not a durable ledger.

### `MemoryUsageStore`

```ts
new MemoryUsageStore({
  idempotencyTtlMs?,
  observer?,
})
```

Process-local reference store for tests and development. Default settled replay tombstone retention: `86_400_000` ms (24 hours).

Pending expired operations release all participating budgets and become reusable. Cost-liable expiry consumes the full reservation and leaves a bounded settled tombstone. With an observer, the memory store emits per-reservation `reservation.recovered` events.

### Core errors

- `UsageStateError` — invalid/expired/conflicting store or resume state.
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

Use `protectMultiRoundTool()` rather than `protectTool()` for supported multi-round `input_required` accounting.

### `McpUsageRequestStatePayload`

```ts
interface McpUsageRequestStatePayload {
  mcpUsageControl: 1;
  flowId: string;
}
```

Decoded payload expected from the MCP server's configured `requestState.verify` hook. The wire value should be minted by an integrity-protected codec such as the official SDK `createRequestStateCodec()`. A raw client-controlled string is rejected by `protectMultiRoundTool()`.

### `McpUsageFlowBinding`

```ts
interface McpUsageFlowBinding {
  principalId: string;
  tenantId?: string;
  tool: string;
  argsHash: string;
}
```

Trusted binding compared server-side before a suspended flow is claimed. `argsHash` is a SHA-256 hash of canonicalized validated tool arguments.

### `McpUsageFlowRecord` / `McpUsageFlowStore`

```ts
interface McpUsageFlowRecord {
  flowId: string;
  binding: McpUsageFlowBinding;
  lease: UsageLeaseResumeState;
  round: number;
  expiresAt: number;
  applicationRequestState?: string;
}

interface McpUsageFlowStore {
  suspend(record: McpUsageFlowRecord): void | Promise<void>;
  consume(
    flowId: string,
    binding: McpUsageFlowBinding,
  ): McpUsageFlowRecord | undefined |
     Promise<McpUsageFlowRecord | undefined>;
}
```

`consume()` is security-critical. It must atomically compare the current trusted binding and consume a matching flow exactly once. A mismatched caller must get no record **without deleting the legitimate flow**.

### `MemoryMcpUsageFlowStore`

Process-local reference implementation of `McpUsageFlowStore`. Use it for tests or a single-process server and instantiate it outside any per-request `createMcpHandler` factory. Horizontally scaled servers need a shared/durable implementation with the same atomic compare-and-consume contract.

### `McpUsageFlowContext`

```ts
interface McpUsageFlowContext {
  readonly round: number;
  readonly operationId: string;
  readonly applicationRequestState?: string;
}
```

Passed as the third application-handler argument by `protectMultiRoundTool()`. `round` starts at `0`; the first resumed request is `1`. `operationId` is the original first-round logical ID. If the application returned its own `requestState` in the preceding `input_required` result, the wrapper retains it server-side and exposes it here instead of trusting it from the client wire value.

### `ProtectMultiRoundToolOptions<TArgs, TResult>`

Extends `ProtectToolOptions` with:

```ts
interface ProtectMultiRoundToolOptions<TArgs, TResult>
  extends ProtectToolOptions<TArgs, TResult> {
  flowStore: McpUsageFlowStore;
  requestState: {
    mint(
      payload: McpUsageRequestStatePayload,
      ctx: ServerContext,
    ): string | Promise<string>;
  };
  suspendTtlMs: number;
  maxRounds?: number; // default 8
  flowId?: () => string | Promise<string>;
}
```

`suspendTtlMs` is required. It bounds how long a cost-liable suspended lease is held before conservative expiry recovery. `flowId` is primarily a testing/customization hook; the default uses cryptographically random IDs.

### `protectMultiRoundTool(options, handler)`

Opt-in MCP v2 multi-round wrapper.

Behavior:

- first round derives principal/operation ID, reserves once, and marks the lease liable;
- `input_required` stops the active heartbeat, renews for `suspendTtlMs`, stores a trusted server-side flow record, and returns a wrapper-owned signed/opaque `requestState`;
- resumed rounds require a verified decoded request-state payload and atomic binding-aware flow consumption;
- resumed rounds call `UsageControl.resumeLease()` and renew the authoritative underlying reservation instead of quoting/reserving again;
- a one-time resume token permits only one handler re-entry; replayed/expired/missing/mismatched state fails closed with `McpUsageResumeError`;
- `maxRounds` bounds repeated suspension; exceeding it conservatively settles the full reservation and raises `McpUsageRoundsExceededError`;
- final success/tool-error/throw classification and settlement use the same rules as `protectTool()`.

The wrapper prevents double reservation and duplicate application re-entry for the same resume token. It does not provide a general exactly-once side-effect guarantee or completed-business-result cache/replay; applications should retain their existing business idempotency/reconciliation for destructive or externally metered work.

See [MCP integration](mcp-integration.md) for the official SDK request-state setup and trust-boundary guidance.

### MCP adapter errors

- `UsageSettlementError` — includes `settlementError` and optional `executionError`.
- `UsageClassificationError` — includes `classificationError` and optional `executionError`.
- `UnsupportedMcpUsageFlowError` — single-round `protectTool()` boundary error for `input_required`.
- `McpUsageResumeError` — missing, expired, replayed, mismatched, or unverified multi-round resume state.
- `McpUsageRoundsExceededError` — repeated `input_required` exceeded configured `maxRounds` after conservative full settlement.

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
  observer?: UsageObserver;
}
```

Defaults:

- `prefix`: `muc`
- `hashTag`: `usage`
- `cleanupBatchSize`: `256`
- `idempotencyTtlMs`: `86_400_000` (24 hours)

The v0.1 Redis store uses one transaction domain containing a used-budget hash, a global lease expiry index, reservation records, operation mappings, and tombstones. Budget IDs and operation identities are hashed before storage identifiers are created.

Lua obtains Redis server `TIME` for lease and tombstone decisions. Multi-budget reserve, release, expiry recovery, renew and settlement do not loop single-budget operations client-side.

When `observer` is configured, lazy cleanup emits aggregate `reservation.recovered` events for pending-release and liable-retention recovery. It does not persist raw principal, tenant, tool, or budget strings solely for telemetry. Directly touching an expired reservation can emit its opaque hashed reservation ID.

See [Redis adapter](redis.md) and [Observability](observability.md) for durability, Redis Cluster, privacy, and telemetry constraints.

## `mcp-usage-control-cloudflare`

### `CloudflareUsageStore`

Worker-local `UsageStore` backed by a Durable Object namespace. Options include `domainName`, `cleanupBatchSize`, `idempotencyTtlMs`, and `observer`. One `domainName` is one atomic transaction domain.

### `RemoteCloudflareUsageStore`

HTTP `UsageStore` for applications outside Cloudflare. `endpoint` is required; non-local endpoints must use HTTPS. Optional request headers can be supplied directly or by callback. `timeoutMs` is a full-call deadline covering async header resolution, fetch, and response decoding. Timeout/network failures surface as `CloudflareUsageTransportError` and are not automatically retried. Non-auth HTTP failures remain `code: 'remote'` and may expose only bounded numeric `status` metadata; response bodies are not propagated.

### `createCloudflareUsageStoreGateway()`

Creates the Worker HTTP handler used by the remote store. An application-defined `authorize(request)` callback is mandatory. The gateway accepts only the hashed accounting protocol produced by the adapter and returns generic failures rather than raw Durable Object exceptions.

### `UsageControlDurableObject`

Exported from `mcp-usage-control-cloudflare/worker`. Uses SQLite transactions for atomic multi-budget reserve, liability, renewal, settlement, replay protection, and expiry recovery.

See [Cloudflare adapter](cloudflare.md) for deployment and trust-boundary details.

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
