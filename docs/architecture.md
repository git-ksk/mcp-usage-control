# Architecture

## Scope

`mcp-usage-control` owns the runtime boundary between an authenticated principal and a metered tool execution:

```text
identity -> entitlement/policy -> quote -> reserve -> tool -> settle
```

It does not own authentication, subscription billing, payment collection, dashboards, or upstream API pricing.

## Why reserve before execution

A `check -> execute -> record` design has a time-of-check/time-of-use race. When several agent tool calls arrive concurrently, each can observe the same remaining balance and all start before any usage is recorded.

The store therefore exposes a single `reserve()` operation. A production store must make quota comparison, duplicate-operation detection, and reservation creation atomic.

## Reservations are renewable leases

Reservation expiry exists to recover quota after a worker crashes, but a fixed TTL is unsafe for legitimate long-running tools. If an active tool runs past its TTL and another admission reclaims the reservation, both operations can consume the same budget.

A pending reservation is therefore a renewable lease. `UsageStore.renew()` atomically extends the expiry only while the reservation is still pending. `UsageLease.renew()` exposes that operation to adapters.

The MCP adapter enables a heartbeat by default and renews at approximately one third of the lease TTL while the handler is in flight. It stops and waits for any in-flight renewal before final settlement so renewal and settlement do not race each other.

Applications that disable the MCP heartbeat are responsible for an equivalent renewal mechanism. The lease TTL should comfortably exceed temporary scheduler/event-loop stalls and expected storage latency; the heartbeat interval must remain well below the TTL.

A sufficiently long storage/network partition can still outlive a distributed lease. A generic library cannot fence an arbitrary upstream API after lease loss, so production stores must fail closed for new admissions while storage is unavailable and must document their expiry/recovery policy. Provider-specific fencing, when available, belongs in the application or adapter.

## Why settlement is not rollback

A tool can fail after an upstream resource was consumed. Automatically refunding every exception creates an incentive and an abuse path where a caller repeatedly triggers post-cost failures.

The runtime uses explicit settlement:

- success: normally settle the actual consumed units;
- pre-cost failure: the application may settle zero;
- post-cost failure: settle the units already incurred;
- unclassified failure: MCP adapter defaults to the full reservation.

The v0.1 contract requires `actualUnits <= reservedUnits`. Dynamic-cost tools should reserve their safe maximum before execution, then release the unused portion at settlement.

## Idempotency

`operationId` is supplied by the application. The store scopes it to the principal and rejects a duplicate reservation. This protects against concurrent retry and accidental duplicate dispatch.

The in-memory reference store keeps settled operation IDs for the process lifetime. The Redis store keeps settled operation IDs behind a longer, configurable idempotency tombstone retention period that is separate from the renewable reservation lease TTL.

Settlement itself is idempotent when the same `actualUnits` and `outcome` are repeated. A conflicting second settlement is rejected.

## Store contract

`UsageStore` is intentionally independent of MCP and storage vendors. The in-memory implementation is for tests and local development.

A production store must provide:

- atomic reserve;
- atomic lease renewal for pending reservations;
- atomic settlement and unused-unit release;
- reservation expiry recovery;
- duplicate operation protection;
- bounded idempotency retention;
- no fail-open behavior on ambiguous storage failures by default.

`@mcp-usage-control/redis` implements these transitions with Redis-side Lua rather than client-side read/modify/write sequences. All transactional keys share one configurable Redis Cluster hash slot so the scripts remain atomic. See [Redis adapter](redis.md) for the key model and scaling trade-off.

## MCP adapter

`@mcp-usage-control/mcp` targets the public `@modelcontextprotocol/server` v2 API. It only depends on the core abstraction and uses the SDK's public `ServerContext` type.

The core package never imports the MCP SDK. This keeps accounting semantics reusable and isolates protocol/SDK churn to the adapter package.

The adapter also keeps tool execution errors separate from settlement errors. An ambiguous settlement is never blindly retried because a storage write may already have been applied even when its acknowledgement was lost.

## Future multi-budget admission

A production SaaS commonly needs several constraints at once, for example:

- user monthly credits;
- user daily credits;
- tenant monthly credits;
- burst/concurrency controls.

The current pre-alpha store has one budget per reservation. Multi-budget atomic admission is planned before v0.1 so all applicable budgets succeed or fail as one transaction.
