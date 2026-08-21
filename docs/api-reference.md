# API reference — current source

[English](api-reference.md) | [日本語](api-reference.ja.md)

This reference describes the public API in the current source tree. All five package manifests are aligned at `0.8.0`. **v0.8.0 is the latest GitHub/source release baseline**; npm registry publication remains intentionally deferred.

For behavioral/failure guarantees, read [Architecture](architecture.md) and [Store implementation contract](store-contract.md). For the stable/deferred v1 boundary, read [v1.0 readiness review](v1-readiness.md).

## `mcp-usage-control`

### `Principal`

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

Trusted accounting identity supplied by the application. It is not an authentication primitive. Derive it from authenticated/authorized server-side state.

### `UsageRequest<TArgs>`

```ts
interface UsageRequest<TArgs = unknown> {
  operationId: string;
  principal: Principal;
  tool: string;
  args: TArgs;
}
```

Replay protection is scoped by:

```text
(tenantId, principal.id, tool, operationId)
```

Use one stable `operationId` for retries of one logical invocation. It is an idempotency input, not identity proof.

### `Budget`

```ts
interface Budget {
  key: string;
  limit: number;
}
```

`key` must be non-empty and `limit` a non-negative safe integer. Window semantics are application policy; encode daily/monthly window identity into the key when needed.

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

`budgets` is the multi-budget form. The same quoted units are reserved against every participating budget atomically. `budget` is a convenience form for one budget. Empty lists and duplicate budget keys are rejected.

Policy denial reasons may reach observability; use bounded non-secret reason codes rather than unrestricted diagnostic text.


### Weighted credit policy helpers

For the common case where MCP tools consume different amounts of one shared credit currency, `defineWeightedCreditPolicyConfig()` validates an already-loaded plain configuration object and `createWeightedCreditsPolicy()` builds a normal `UsagePolicy`. The helper owns only deterministic quote composition; entitlement lookup, configuration loading/distribution, accounting-window identity, and billing history stay application-owned.

```ts
import {
  createWeightedCreditsPolicy,
  defineWeightedCreditPolicyConfig,
} from 'mcp-usage-control';

const creditConfig = defineWeightedCreditPolicyConfig({
  tools: {
    search: 1,
    summarize: 3,
    ai_analyze: 5,
    browser_action: 10,
  },
  plans: {
    free: { limits: { monthly: 50 } },
    plus: { limits: { monthly: 100 } },
  },
  unknownTool: 'deny',
});

const policy = createWeightedCreditsPolicy({
  config: creditConfig,
  budgets: ({ request, limit }) => ({
    // Window/key construction is application-owned. Keep the plan name out of
    // this identity so Free -> Plus does not reset already-consumed August usage.
    key: `month:user:${request.principal.id}:2026-08`,
    limit: limit('monthly'),
  }),
});
```

Unknown tools deny with `unknown_tool` by default. An explicit `{ fallbackUnits }` may be configured instead. Missing or unknown plans deny with `unknown_plan`. Tool units, named plan limits, fallback units, unknown configuration fields, and a fixed reservation TTL are validated eagerly. The configuration is snapshotted when the policy is created so later mutation of the caller's object cannot silently change active pricing.

`plans.*.limits` is a named limit bag rather than a subscription database: the application chooses how those names map to one or more `Budget` objects in `budgets()`. `limit(name)` fails closed when a requested name is absent. `resolvePlan` may be supplied when trusted entitlement truth does not live in `request.principal.plan`.

The helper accepts an **already-loaded object** only. JSON/YAML/file/Remote Config access is deliberately out of scope. Duplicate textual JSON keys cannot be detected after normal parsing has collapsed them, so loaders that require duplicate-key rejection must enforce that before calling this API.

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

A production implementation must preserve atomic admission, replay, liability, renewal, expiry, settlement, and fail-closed semantics. Method-shape compatibility alone is not enough; see [Store implementation contract](store-contract.md).

### Store-side reserve result

An accepted store reservation includes:

```ts
{
  accepted: true;
  reservation: ReservationRecord;
  remainingByBudget: Array<{
    key: string;
    remaining: number;
  }>;
}
```

A denied result is one of the Store-defined denial reasons, currently `quota_exceeded` or `duplicate_operation`. `quota_exceeded` may include the limiting budget and remaining units.

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

Default reservation TTL: `60_000` ms. The numeric third argument remains source-compatible.

Main methods:

```ts
await control.reserve(request)
control.resumeLease(state)
```

`reserve()` evaluates policy, canonicalizes budgets, performs atomic Store admission, and returns `AdmissionResult`.

`resumeLease()` reattaches to an already-created reservation from trusted server-side `UsageLeaseResumeState`. It does not call `policy.quote()` or `store.reserve()` again; subsequent Store operations remain authoritative.

### `AdmissionResult`

```ts
type AdmissionResult =
  | {
      allowed: true;
      lease: UsageLease;
      remainingByBudget: Array<{
        key: string;
        remaining: number;
      }>;
    }
  | {
      allowed: false;
      reason: string;
      limitingBudgetKey?: string;
      remaining?: number;
    };
```

`remainingByBudget` is copied from the authoritative Store result. Consumers should not recompute it from configured limits. Budget keys may be sensitive/high-cardinality; expose them only under explicit application policy.

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

Trusted server-side resumable accounting state. It is not a client credential or bearer token. Do not expose the raw structure to an untrusted client.

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

- `markLiable()` declares entry into the cost-bearing execution boundary.
- `renew()` extends an active pending or liable lease.
- `settle()` is terminal and requires `0 <= actualUnits <= reservedUnits`.
- `toResumeState()` returns detached trusted server-side resume state.

Expired pending reservations may release capacity. Expired liable reservations conservatively retain the full reserved charge when actual usage is unknown.

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

Identical replay is idempotent while the Store retains the tombstone. A conflicting replay with different units or outcome fails.

### `UsageOperationReconciliationInput` / `UsageOperationReconciliation` / `OperationReconciliationStore` (v0.8)

```ts
interface UsageOperationReconciliationInput {
  request: UsageRequest;
  units: number;
  budgets: readonly Budget[];
}

type UsageOperationReconciliation =
  | { status: 'absent'; reservationId: string }
  | { status: 'active'; state: 'pending' | 'liable'; reservation: ReservationRecord }
  | { status: 'expired'; state: 'pending' | 'liable'; reservationId: string; expiredAt: number }
  | {
      status: 'settled';
      reservationId: string;
      reservedUnits: number;
      actualUnits: number;
      tombstoneExpiresAt: number;
    };

interface OperationReconciliationStore extends UsageStore {
  reconcileOperation(
    input: UsageOperationReconciliationInput,
  ): Promise<UsageOperationReconciliation>;
}
```

This is an optional **scalar-only, read-only** Store capability. It proves retained usage-enforcement state without allocating a second reservation or changing liability/lease/settlement state. The input must use the trusted logical operation identity, expected currently retained scalar units, and expected budget keys. Mutable budget limits are not historical identity and are not required to match an old value.

`absent` means no retained state is visible now; after a Store retention horizon it is not proof that the operation never existed. Any transport/backend failure, corrupt/unsupported state, or identity/quote mismatch rejects rather than becoming `absent`; callers treat such uncertainty as indeterminate and fail closed. See [Operation reconciliation/status](operation-reconciliation.md).

### `MemoryUsageStore`

```ts
new MemoryUsageStore({
  idempotencyTtlMs?,
  maxRetainedOperations?,
  maxRetainedBudgetKeys?,
  observer?,
})
```

Process-local reference implementation for tests, local development, and controlled single-process deployments. Defaults:

- settled replay retention (`idempotencyTtlMs`): 24 hours;
- `maxRetainedOperations`: `100_000` active reservations plus settled replay tombstones;
- `maxRetainedBudgetKeys`: `100_000` distinct non-zero budget keys.

The store does not silently evict authoritative accounting or replay state when those bounds are reached. Admission fails closed with `MemoryUsageStoreCapacityError` instead.

Operational helpers:

```ts
store.stats()
store.retireBudgetKey(budgetKey)
```

`stats()` returns current retained-operation/budget-key counts and configured limits. These are retention-pressure counters, not consumed-usage totals; `retainedOperations` includes active reservations and replay tombstones. `retireBudgetKey()` explicitly forgets one completed accounting-window key; it rejects keys still referenced by active reservations. The application must guarantee that a retired key will not be reused for the same accounting window. Generic automatic TTL/LRU eviction of non-zero usage is intentionally not performed because it could reset quota semantics.

Expiry/tombstone cleanup is lazy and scheduled around the earliest known deadline rather than scanning all reservations on every store call. The store remains process-local and is not a horizontally or restart-durable production Store. See [Memory store operations](memory-store.md).

### `UsageObserver` / `UsageEvent`

```ts
interface UsageObserverHandler {
  onEvent(event: UsageEvent): void | Promise<void>;
}

type UsageObserver = UsageObserverHandler | undefined;
```

Lifecycle event types currently include:

- `reserve.accepted`
- `reserve.denied`
- `settlement.completed`
- `reservation.recovered`
- `operation.error`

Observer delivery is best-effort and outside the enforcement transaction. Returned promises are not awaited; synchronous throws and asynchronous rejections do not change accounting outcomes.

`UsageEventMetadata` is an explicit opt-in `Record<string, string | number | boolean | null>`.

### `projectUsageEvent()`

Projects raw lifecycle events into a low-cardinality operational shape. The default projection excludes identity IDs, operation/reservation IDs, tool/budget identifiers, unrestricted settlement outcomes, and application-defined denial text.

This is observability, not the transactional ledger.

### Core errors

- `UsageStateError` — invalid, expired, missing, or conflicting Store/resume state.
- `UsageDeniedError` — programmatic denial reason with a deliberately generic thrown message.
- `MemoryUsageStoreCapacityError` — bounded in-memory operation or budget-key retention is exhausted; accounting state is retained and the store fails closed rather than evicting it.

## `mcp-usage-control/conformance`

`v0.3.0` added a public conformance subpath:

```ts
import {
  runUsageStoreConformance,
  assertUsageStoreConformance,
  UsageStoreConformanceError,
  type UsageStoreConformanceHarness,
  type UsageStoreConformanceReport,
} from 'mcp-usage-control/conformance';
```

The base portable runner covers provider-neutral behavior including multi-budget atomicity, concurrent admission, replay scope, liability idempotency, renewal, settlement replay/conflict, invalid-settlement non-corruption, and pending/liable expiry.

v0.8 also exports `runOperationReconciliationStoreConformance()` and `assertOperationReconciliationStoreConformance()` for Stores implementing optional `OperationReconciliationStore`. That suite covers `absent -> pending -> liable -> settled`, read-only expired observation, and fail-closed expected-state mismatch.

Passing these establishes **behavioral compatibility**, not persistence/HA, authoritative-time, failover, or lost-ACK safety. Those require backend-specific evidence.

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

For tools with no input schema, use `noInput: true`.

### `protectTool(options, handler)`

Single-round MCP TypeScript SDK v2 wrapper.

Behavior:

- reserve before handler execution;
- `markLiable()` immediately before handler entry;
- heartbeat enabled by default;
- normal success / MCP `{ isError: true }` / thrown exception classified separately;
- invalid/throwing classifier -> conservative full settlement, then classification error;
- settlement failure -> surfaced without blind retry;
- `input_required` -> unsupported in this single-round wrapper; use `protectMultiRoundTool()`.

### `McpUsageRequestStatePayload`

```ts
interface McpUsageRequestStatePayload {
  mcpUsageControl: 1;
  flowId: string;
}
```

The wrapper accepts this only after the MCP server request-state verification hook has decoded/verified the wire value. Raw client-controlled state fails closed.

### `McpUsageFlowBinding`

```ts
interface McpUsageFlowBinding {
  principalId: string;
  tenantId?: string;
  tool: string;
  argsHash: string;
}
```

`argsHash` binds resume to canonicalized validated original arguments.

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

`consume()` must atomically compare principal/tenant/tool/args binding and consume a matching flow once. Mismatch must not consume the legitimate flow.

### `MemoryMcpUsageFlowStore`

Process-local reference flow store. Use only for tests/single-process servers. Instantiate it outside per-request handler factories.

### `McpUsageFlowContext`

```ts
interface McpUsageFlowContext {
  readonly round: number;
  readonly operationId: string;
  readonly applicationRequestState?: string;
}
```

`round` begins at 0. A handler-authored application request state is retained server-side and exposed on the next resumed round through this context.

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

### `protectMultiRoundTool(options, handler)`

Opt-in `input_required` multi-round accounting wrapper.

- first round reserves once and enters liability before application execution;
- suspension renews to `suspendTtlMs` and stores trusted flow state server-side;
- resumed requests require verified request state and binding-aware one-time flow consumption;
- resume uses `UsageControl.resumeLease()` rather than a second quote/reserve;
- missing/replayed/expired/mismatched state fails closed;
- `maxRounds` bounds repeated suspension;
- final settlement uses the same conservative classification rules as `protectTool()`.

The wrapper is not a generic exactly-once side-effect/result-replay system.

### MCP adapter errors

- `UsageSettlementError`
- `UsageClassificationError`
- `UnsupportedMcpUsageFlowError`
- `McpUsageResumeError`
- `McpUsageRoundsExceededError`

## `mcp-usage-control-mcp/conformance`

```ts
import {
  runMcpUsageFlowStoreConformance,
  assertMcpUsageFlowStoreConformance,
  McpUsageFlowStoreConformanceError,
  type McpUsageFlowStoreConformanceHarness,
  type McpUsageFlowStoreConformanceReport,
} from 'mcp-usage-control-mcp/conformance';
```

The portable runner covers one-time consume, binding-mismatch preservation, concurrent one-winner consume, duplicate suspend rejection, and expiry rejection.

Backend durability and lost-consume-ACK behavior remain implementation-specific evidence requirements.

## `mcp-usage-control-redis`

### `RedisUsageStore`

```ts
new RedisUsageStore(client, options?)
```

`client` provides an `eval(script, { keys, arguments })` method compatible with `RedisEvalClient`.

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
- `idempotencyTtlMs`: 24 hours

The Store uses one Redis Lua transaction domain for multi-budget admission/lifecycle state and Redis server `TIME` for lease/tombstone decisions.

### `mcp-usage-control-redis/mcp-flow`

```ts
import { RedisMcpUsageFlowStore } from 'mcp-usage-control-redis/mcp-flow';
```

Shared Redis flow store for horizontally scaled MCP multi-round accounting. It atomically compares a SHA-256 binding digest and deletes a matching flow in one Lua invocation. Per-flow keys share a Redis Cluster hash slot; unrelated flows may distribute across slots.

Redis persistence/HA remains deployment-specific.

## `mcp-usage-control-cloudflare`

### `CloudflareUsageStore`

Worker-local `UsageStore` backed by one Durable Object transaction domain.

### `RemoteCloudflareUsageStore`

HTTP Store for applications outside Cloudflare. Non-local endpoints require HTTPS. Optional request headers may be static or callback-based. `timeoutMs` bounds the full remote call.

Timeout/network/ambiguous remote failures are surfaced as transport errors and are not automatically retried. Response bodies are not propagated through transport errors.

### `createCloudflareUsageStoreGateway()`

Creates the authenticated Worker gateway for the remote Store. Application-defined `authorize(request)` is mandatory; there is no unauthenticated default.

### `mcp-usage-control-cloudflare/worker`

Exports the Durable Object implementation, including `UsageControlDurableObject` and versioned Worker entry points used by deployment code.

### `mcp-usage-control-cloudflare/reconciliation`

Exports explicit authenticated read-only scalar operation reconciliation helpers. `reconcileRemoteCloudflareOperation()` is the v0.8 provider-neutral operation-status entry point. `reconcileRemoteCloudflareReserve()` remains as the v0.7-compatible alias for ambiguous initial-reserve acknowledgement recovery. Reconciliation must not create additional quota.

### `mcp-usage-control-cloudflare/maintenance`

Exports explicitly authorized historical-budget maintenance/pruning helpers. Maintenance authority is separate from routine usage authority.

See [Cloudflare adapter](cloudflare.md) for exact deployment APIs and trust boundaries.

## `mcp-usage-control-firestore`

### `FirestoreUsageStore`

```ts
new FirestoreUsageStore(firestore, options?)
```

`firestore` is a server-side Firestore client satisfying the adapter structural contract.

### `FirestoreUsageStoreOptions`

```ts
interface FirestoreUsageStoreOptions {
  collectionPrefix?: string;
  idempotencyTtlMs?: number;
  cleanupBatchSize?: number;
  cleanupIntervalMs?: number;
  expiryGraceMs?: number;
  observer?: FirestoreRecoveryObserver;
  now?: () => number;
}
```

Defaults:

- `collectionPrefix`: `muc`
- `idempotencyTtlMs`: 24 hours
- `cleanupBatchSize`: `16`
- `cleanupIntervalMs`: `5_000`
- `expiryGraceMs`: `5_000`

`now` is a test hook. Production normally uses host time plus `expiryGraceMs`; production hosts must be time-synchronized.

The adapter hashes operation/budget identifiers for document IDs, performs all-or-nothing admission in Firestore transactions, and recovers pending/liable state conservatively.

### `recoverExpired(limit?)`

Runs bounded explicit recovery and returns a `FirestoreRecoverySummary`. `reserve()` may also run throttled best-effort cleanup depending on configuration.

Shared tenant/global budget documents can become contention hotspots. See [Firestore adapter](firestore.md).

## MCP Tasks support boundary

The source tree does not currently export a stable first-class Tasks protocol adapter.

The safe accounting state machine is defined in [MCP Tasks accounting](mcp-tasks-accounting.md) and proof-tested using existing core lease primitives. Stable protocol integration remains deferred while the upstream TypeScript Tasks surface is experimental.

## Numeric validation

- units / limits: non-negative JavaScript safe integers;
- TTL / retention values: positive safe integers;
- settlement/classifier units: non-negative safe integers and `<= reservedUnits`.

## Compatibility

- Node.js 20+
- ESM
- MCP TypeScript SDK v2; current conformance uses the `2026-07-28` protocol line and SDK 2.0.0 path
- Redis 7 integration behavior; node-redis 6.2.x in CI
- Cloudflare Workers / SQLite Durable Objects local workerd integration plus documented deployed dogfood evidence
- Firestore Emulator integration and `@google-cloud/firestore` 8.7.0 type/runtime compatibility evidence

The project remains pre-v1 until a separately authorized v1 release. The current source API is assessed as ready for v1 release-candidate/final-release preparation; see [v1.0 readiness review](v1-readiness.md).

## Progressive reservation growth (v0.6)

`ReservationRecord` may include an opaque `growthCursor`. `UsageLease.grow({ incrementId, additionalUnits, budgets })` requests capacity on the same logical reservation and returns an accepted/denied `StoreGrowResult`. A thrown Store/transport error leaves the attempt unresolved; the same lease permits only an exact retry until an authoritative result is obtained.

Stores opt in through `ProgressiveUsageStore.growReservation()`. The base `UsageStore` interface is unchanged, so existing third-party fixed-reservation implementations remain compatible.

The public conformance subpath also exports `runProgressiveUsageStoreConformance()` for Stores that claim growth support.

See [Progressive reservation growth](progressive-reservation-growth.md).

## Vector usage APIs (v0.7)

`VectorUsagePolicy` returns a canonical dimension vector instead of one scalar `units` value. `VectorUsageControl.reserve()` returns a `VectorUsageLease` when the configured Store implements optional `VectorUsageStore`.

`VectorUsageLease` exposes `reservedByDimension`, `markLiable()`, `renew()`, `grow()`, `settle()`, and `toResumeState()`. `grow()` takes one stable `incrementId` plus the complete dimension/budget topology. `settle()` takes every dimension exactly once as `{ key, actualUnits }`.

`VectorUsageStore` adds `reserveVector()`, `growVectorReservation()`, and `settleVector()` while inheriting the shared lifecycle operations from `UsageStore`. Existing third-party scalar Stores do not need to implement these methods.

The public `runVectorUsageStoreConformance()` entry point verifies atomic admission, replay/cursor behavior, expiry, settlement bounds, scalar/vector operation collision, and growth/settlement races. See [Atomic heterogeneous usage vectors](vector-usage.md).
