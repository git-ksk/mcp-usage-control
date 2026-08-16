# Store implementation contract

[English](store-contract.md) | [日本語](store-contract.ja.md)

This document is the normative compatibility boundary for third-party stores.

Implementing the same TypeScript method names is **not** enough to claim production-safe compatibility. A store participates directly in the enforcement transaction and must preserve the same failure semantics under concurrency, retries, expiry, process loss, and acknowledgement ambiguity.

Two contracts are covered:

1. `UsageStore` — quota reservation, liability, renewal, settlement, and expiry recovery;
2. `McpUsageFlowStore` — trusted one-time compare-and-consume state for MCP multi-round resume.

## Compatibility levels

Use these terms deliberately:

### Behaviorally compatible

A store is **behaviorally compatible** when it passes the portable conformance kit and implements the public method semantics below.

This proves normal/concurrent state-machine behavior. It does **not** prove persistence, failover, authoritative time, or network ambiguity behavior.

### Production-safe for a stated deployment model

A store may be described as **production-safe for a stated deployment model** only when it both:

- passes the portable behavioral conformance kit; and
- supplies implementation-specific evidence for the durability/failure requirements in this document.

There is intentionally no context-free label such as “fully durable.” Redis persistence/HA, Firestore host-clock assumptions, Durable Object durability, or another backend's replication/failover model are deployment properties that must be stated explicitly.

A store that merely “works” in happy-path tests must not be presented as production-safe.

## `UsageStore` transaction contract

Budget-window semantics remain application-owned across all implementations. A Store must treat an identical `budget.key` as the same authoritative accounting bucket and must not invent daily/monthly reset behavior or discard non-zero budget state merely because wall-clock time advanced. Safe retirement of historical windows is an application lifecycle decision unless an application-specific Store contract explicitly defines it.

The core interface is:

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

### 1. Atomic admission

`reserve()` is one atomic state transition across **all** participating budgets and the logical-operation replay record.

For an admitted request the store must, as one indivisible decision:

- verify every budget can admit `units`;
- reserve the same `units` from every listed budget;
- create the active reservation;
- claim the logical operation identity `(tenantId, principal.id, tool, operationId)`.

If any budget denies, **no** participating budget may be partially changed and the operation identity must not be claimed as an admitted operation.

A split implementation such as:

```text
read counters -> decide -> write each counter independently
```

is not compatible, even if it passes sequential tests.

### 2. Concurrency

Concurrent `reserve()` calls against overlapping budgets must serialize/coordinate at the store's authoritative transaction boundary so the configured limit cannot be oversubscribed.

Correctness is required across all processes/instances that share the same enforcement domain. A process-local mutex does not make a horizontally scaled store safe.

### Mutable effective limits

The authoritative accounting bucket is identified by `budget.key`; `budget.limit` is the effective policy ceiling supplied for the **current admission attempt**. A compatible Store must not persist a limit in a way that makes a later legitimate limit change reset, replace, or reinterpret already authoritative usage.

For the same `budget.key`:

- raising the supplied limit preserves existing reserved/consumed usage and exposes only the newly available headroom;
- lowering the supplied limit preserves existing reserved/consumed usage and denies new admission while authoritative usage is at or above the lower limit;
- a limit change does not cancel, shrink, refund, re-price, or re-admit an existing pending or liable reservation;
- settlement continues to retain actual usage and releases only normal unused reserved capacity;
- a plan/override change must not require a different key unless the application intentionally means a new accounting bucket/window.

Conceptually, each admission evaluates:

```text
remaining = max(0, suppliedEffectiveLimit - authoritativeUsedOrReserved)
```

The Store provides atomic accounting, not distributed policy-version consensus. If concurrent application instances supply different limits for the same key, each reserve attempt is evaluated against its supplied limit and the then-authoritative usage. A stale caller with a higher limit can therefore admit work that a caller already using a stricter limit would deny. Applications requiring a strict downgrade cutover must coordinate effective-policy rollout outside the Store.

See [Mutable quota limits](mutable-quota-limits.md) for upgrade, downgrade, trial, override, and rollout examples.

### 3. Logical-operation replay identity

Duplicate protection is scoped by the exact tuple:

```text
(tenantId, principal.id, tool, operationId)
```

Do not build this key using an ambiguous delimiter concatenation. Use an unambiguous encoding or a collision-resistant digest over an unambiguous tuple encoding.

The same `operationId` in another tenant or for another tool is a different operation.

The operation ID is an idempotency input, not authentication. The application remains responsible for supplying trusted principal/tenant/tool identity.

### 4. Reservation records

An accepted `reserve()` returns a reservation bound to the admitted request and budgets. `reservationId` must identify exactly one authoritative reservation and must not be forgeable into authority merely by client possession.

Store implementations should validate externally supplied reservation IDs before using them in backend keys/queries.

### 5. `pending -> cost-liable`

A reservation starts `pending` and becomes cost-liable through `markLiable()` immediately before work may incur metered cost.

`markLiable()` on the same still-active liable reservation must be idempotent. This prevents a repeated transition attempt from creating another accounting effect.

A store must never silently transform an expired pending reservation into a fresh active one during `markLiable()`.

### 6. Lease renewal

`renew()` may extend an existing active pending or liable reservation. It must not recreate an expired/missing/settled reservation.

The returned `expiresAt` must reflect the authoritative store decision. Implementations must document their time authority:

- server/store time is preferred for distributed stores where available;
- a host-clock design must document skew assumptions and any expiry grace;
- clients must not control the authoritative current time used for expiry decisions.

### 7. Pending expiry

When an active `pending` reservation expires:

- release its reserved units from **every** participating budget atomically;
- remove/release its active logical-operation claim so the operation may be admitted again after recovery;
- never leave a partial release across budgets.

Recovery may be eager, lazy, or scheduled, but admission must not overcount/undercount capacity because cleanup ran on only part of the reservation.

### 8. Cost-liable expiry

When a `liable` reservation expires before authoritative settlement:

- do **not** release the reserved units optimistically;
- conservatively retain the full reservation as consumed;
- retain duplicate-operation protection for the configured idempotency period;
- represent the recovery as equivalent to full settlement with an implementation-defined/internal outcome such as `lease_expired_after_execution_started`.

Process loss after execution may have started must never become an automatic refund.

### 9. Settlement

`settle()` is a terminal transition for an active reservation.

Required semantics:

- `0 <= actualUnits <= reservedUnits`;
- release `reservedUnits - actualUnits` from every participating budget atomically;
- retain `actualUnits` as consumed;
- retain a bounded tombstone/replay record;
- return the same settlement on an identical replay while that tombstone is retained;
- reject a replay with different `actualUnits` or `outcome`.

An invalid settlement attempt such as `actualUnits > reservedUnits` must not corrupt or terminally alter the valid active reservation.

### 10. Acknowledgement ambiguity

A transport or process can lose the response after the store committed a state transition.

The store/deployment must define each case explicitly:

- **reserve ACK lost** — retry under the same logical identity must not create a second reservation; a read-only reconciliation path may be provided;
- **markLiable ACK lost** — the caller must not enter metered work unless it can establish a safe transition; a committed transition may later conservatively retain the reservation;
- **renew ACK lost** — the caller must not assume the extension succeeded;
- **settle ACK lost** — an identical settlement may be replayed where tombstone idempotency is available; a conflicting settlement must fail.

Do not add automatic retry middleware around unknown state-changing outcomes unless the retry is proven idempotent under this contract.

### 11. Storage/backend failures are fail-closed

A backend error during admission must not become `{ accepted: true }` or a policy allow decision.

Cleanup/recovery failures may conservatively leave too much capacity reserved, but must not create extra admission capacity.

Unexpected/corrupt stored state should fail closed with an explicit error rather than being interpreted as an empty/new reservation.

### 12. Durability and failover

Atomicity is not the same as durability.

A production deployment must state what happens if the authoritative backend:

- loses acknowledged writes;
- fails over to a replica;
- restarts during a transaction;
- partitions from an application instance;
- returns success and then loses the committed state.

If the deployment can lose an acknowledged reservation and subsequently admit conflicting work, it is not production-safe for strict enforcement regardless of API-level conformance.

### 13. Untrusted input and privacy

Store boundaries may receive policy-controlled budget keys and application-controlled identity values. Implementations must:

- validate lengths/ranges/formats needed by the backend;
- avoid query/key injection through raw concatenation;
- avoid logging secrets or tool arguments by default;
- treat hashing as identifier minimization, not encryption;
- avoid exposing raw identity material solely for observability when an opaque identifier is sufficient.

## Portable `UsageStore` conformance kit

The package exports a framework-independent runner:

```ts
import { assertUsageStoreConformance } from 'mcp-usage-control/conformance';

await assertUsageStoreConformance({
  createStore(scenario) {
    // Return a fresh/isolated transaction domain for each scenario.
    return createMyStore({ namespace: `contract-${scenario}` });
  },
  async waitForLeaseExpiry(ttlMs, scenario) {
    // Sleep, advance an emulator clock, or otherwise wait for the store's
    // authoritative TTL + configured expiry grace.
    await waitForMyStoreExpiry(ttlMs, scenario);
  },
  async cleanup(scenario) {
    await deleteMyTestNamespace(scenario);
  },
});
```

The runner currently proves provider-neutral behavior for:

- all-or-nothing multi-budget denial;
- concurrent admission at a shared limit;
- limit increase without resetting existing usage;
- limit decrease while usage is pending, liable, and settled;
- concurrent stricter/stale-higher policy views against the same authoritative bucket;
- logical-operation replay scope;
- idempotent liability transition;
- active lease renewal;
- identical settlement replay and conflicting settlement rejection;
- invalid settlement non-corruption;
- pending expiry release;
- liable expiry conservative retention and replay protection.

Passing the runner is **necessary but not sufficient** for a production-safe claim. Store-specific fault/ACK/durability evidence remains required.

## `McpUsageFlowStore` compare-and-consume contract

`protectMultiRoundTool()` uses a separate store for one-time resume claims:

```ts
interface McpUsageFlowStore {
  suspend(record: McpUsageFlowRecord): void | Promise<void>;
  consume(
    flowId: string,
    binding: McpUsageFlowBinding,
  ): McpUsageFlowRecord | undefined |
     Promise<McpUsageFlowRecord | undefined>;
}
```

This is not a general workflow database. It has one security-critical purpose: trusted, bounded, one-time resume authority.

### Required semantics

- `suspend()` must reject an already-present flow ID rather than overwrite it;
- stored flow state is server-side trusted state, not a client credential;
- `consume()` must atomically compare **principal ID, optional tenant ID, tool, and args hash**;
- a mismatch returns no record **without consuming the legitimate flow**;
- a matching consume removes/claims the flow exactly once in the same atomic operation;
- concurrent matching consumers must produce at most one winner;
- expired flow state must not resume;
- corrupt/partially stored state must fail closed, not be treated as a mismatch or fresh state;
- a lost consume ACK must never be followed by blind `consume()` retry plus business-handler re-entry because the first consume may already have committed.

Horizontal scale requires the flow store to be shared/durable across instances. Sticky MCP session affinity is not a substitute for the compare-and-consume invariant.

## Portable MCP flow-store conformance kit

`mcp-usage-control-mcp` exports a second framework-independent runner:

```ts
import {
  assertMcpUsageFlowStoreConformance,
} from 'mcp-usage-control-mcp/conformance';

await assertMcpUsageFlowStoreConformance({
  createStore(scenario) {
    return createMyFlowStore({ namespace: scenario });
  },
  async waitForFlowExpiry(ttlMs) {
    await sleepPastAuthoritativeExpiry(ttlMs);
  },
});
```

It proves:

- one-time matching consume;
- principal/tenant/tool/args mismatch preservation;
- concurrent one-winner consume;
- duplicate suspend rejection without destroying the original flow;
- expiry rejection.

As with `UsageStore`, backend durability and lost-consume-ACK behavior need implementation-specific evidence beyond the portable runner.

## Built-in implementation evidence

The built-in stores combine the portable semantics with provider-specific tests/documentation. The same `UsageStore` conformance runner is exercised against Memory in unit CI, Redis in the normal Redis-backed test matrix, Cloudflare Durable Objects through local workerd, and Firestore through the Local Emulator Suite.

| Store | Atomic primitive | Time model | Production-specific evidence/boundary |
| --- | --- | --- | --- |
| `MemoryUsageStore` | process-local synchronous state | host `Date.now()` | reference implementation; controlled single-process use may accept restart loss, but it is not restart-durable or horizontally shared |
| `RedisUsageStore` | one Redis Lua transaction domain | Redis `TIME` | portable conformance, concurrency, ACK-loss, expiry, renew, replay tests; persistence/HA remains deployment-specific |
| `CloudflareUsageStore` | one Durable Object + SQLite transaction domain | Durable Object runtime/store | portable conformance via local workerd + deployed dogfood; remote ambiguity is surfaced, not blindly retried |
| `FirestoreUsageStore` | Firestore transactions | host clock + documented grace | portable conformance via emulator plus bounded-skew/ambiguity evidence; shared-document contention remains a deployment limit |
| `MemoryMcpUsageFlowStore` | process-local compare/delete | host `Date.now()` | reference/single-process only |
| `RedisMcpUsageFlowStore` | per-flow Redis Lua compare/delete | Redis expiry/server time | concurrent consume, mismatch preservation, lost-consume-ACK fail-closed tests; Redis HA remains deployment-specific |

Passing built-in tests does not turn an underlying provider into a financial ledger. The project enforces usage admission; financial-grade durability remains a separate system boundary where required.
