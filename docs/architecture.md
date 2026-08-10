# Architecture

[English](architecture.md) | [日本語](architecture.ja.md)

## Scope

`mcp-usage-control` owns the runtime boundary between an authenticated principal and a metered tool execution:

```text
identity -> entitlement/policy -> quote -> reserve -> mark liable -> execute -> settle
                                                   ^                 |
                                                   |------ renew -----|
```

It does not own authentication, subscription billing, payment collection, dashboards, or upstream API pricing.

## Why reserve before execution

A `check -> execute -> record` design has a time-of-check/time-of-use race. When several agent tool calls arrive concurrently, each can observe the same remaining balance and all start before any usage is recorded.

The store therefore exposes a single `reserve()` operation. A production store must make quota comparison, duplicate-operation detection, and reservation creation atomic.

## Pending vs cost-liable leases

A reservation starts in a **pending** state. Pending means capacity is reserved but the metered execution boundary has not yet been entered. If a pending lease expires, its units may be released because no metered work was declared liable.

Before metered execution begins, the caller moves the lease to **cost-liable** with `UsageLease.markLiable()`. The MCP adapter does this immediately before entering the application handler. Once a lease is liable, expiry is conservative: the full reservation remains charged and the operation becomes settled with `lease_expired_after_execution_started`.

This distinction closes a crash-after-cost gap. Without it, a process could call an upstream API, disappear before settlement, and later have the lease reclaimed as if no work occurred.

The generic MCP wrapper marks liability at handler entry because it cannot know the exact provider-specific point where cost starts. This may over-account a crash that happens inside the handler before real upstream cost is incurred, but it avoids under-accounting by default. Applications that need a later and more precise cost-liability boundary should use the core lifecycle directly or a provider-specific adapter rather than weakening the generic wrapper.

## Reservations are renewable leases

Reservation expiry exists to recover capacity after a worker disappears, but a fixed TTL is unsafe for legitimate long-running tools. If an active tool runs past its TTL and another admission reclaims the reservation, both operations can consume the same budget.

`UsageStore.renew()` atomically extends the expiry while a reservation remains active. The MCP adapter enables a heartbeat by default and renews at approximately one third of the lease TTL while the handler is in flight. It stops and waits for any in-flight renewal before final settlement so renewal and settlement do not race each other.

A sufficiently long storage/network partition can still outlive a distributed lease. The built-in heartbeat is renewal convenience, not provider-specific fencing. Renewal errors do not automatically cancel arbitrary upstream work. Because the lease is already cost-liable, expiry is conservative rather than refunding the work; final settlement will surface a lost/expired lease if ownership was lost.

Applications that require immediate cancellation after lease loss must fence or cancel at the metered resource boundary.

## Why settlement is not rollback

A tool can fail after an upstream resource was consumed. Automatically refunding every exception creates an abuse path where a caller repeatedly triggers post-cost failures.

The runtime uses explicit settlement:

- success: normally settle the actual consumed units;
- pre-cost failure: the application may settle zero when it can prove no metered resource was consumed;
- post-cost failure: settle the units already incurred;
- unclassified failure: the MCP adapter defaults to the full reservation;
- cost-classification failure: the MCP adapter settles the full reservation before surfacing `UsageClassificationError`.

The current contract requires `actualUnits <= reservedUnits`. Dynamic-cost tools should reserve their safe maximum before execution, then release the unused portion at settlement.

## MCP tool-result semantics

MCP has more than one failure/result shape. The adapter treats an explicit `{ isError: true }` tool result as a tool error, not success. A separate `toolErrorUnits` hook can classify its actual cost; the conservative default remains the full reservation.

MCP v2 also supports `input_required`, where the client gathers input and invokes the handler again in a fresh request. Correct accounting needs suspend/resume semantics across rounds. The pre-alpha `protectTool()` wrapper therefore **does not support `input_required` yet**. If a wrapped handler returns it, the reservation is conservatively settled and `UnsupportedMcpUsageFlowError` is surfaced rather than silently double-charging or deadlocking on duplicate operation IDs.

True multi-round reservation resume is tracked as a separate v0.1 design item.

## Idempotency

`operationId` is supplied by the application. The current store scopes it to the principal and rejects a duplicate reservation. Internal operation keys use unambiguous tuple encoding before storage/hashing so delimiter-containing identifiers cannot collide.

The in-memory reference store keeps settled operation IDs for the process lifetime. The Redis store keeps settled operation IDs behind a longer, configurable idempotency tombstone retention period that is separate from the renewable lease TTL.

Settlement itself is idempotent when the same `actualUnits` and `outcome` are repeated. A conflicting second settlement is rejected.

Principal/tenant/tool scoping semantics remain intentionally under review before v0.1; `operationId` is an idempotency input, never authentication proof.

## Store contract

`UsageStore` is intentionally independent of MCP and storage vendors. The in-memory implementation is for tests and local development.

A production store must provide:

- atomic reserve;
- atomic pending -> cost-liable transition;
- atomic lease renewal for active reservations;
- atomic settlement and unused-unit release;
- state-dependent expiry recovery;
- duplicate operation protection;
- bounded idempotency retention;
- no fail-open behavior on ambiguous storage failures by default.

`@mcp-usage-control/redis` implements these transitions with Redis-side Lua rather than client-side read/modify/write sequences. All transactional keys share one configurable Redis Cluster hash slot so the scripts remain atomic. Lease timestamps are derived from Redis server time inside the Lua scripts so application-host clock skew does not change expiry decisions.

Atomicity is not the same as durability. Redis persistence, replication, failover and acknowledged-write-loss windows are deployment concerns and must be chosen to match the accounting guarantees required by the application. See [Redis adapter](redis.md).

## MCP adapter

`@mcp-usage-control/mcp` targets the public `@modelcontextprotocol/server` v2 API for single-round tool handlers. The core package never imports the MCP SDK, which keeps protocol/SDK churn isolated to the adapter.

The adapter keeps execution errors, classification errors and settlement errors distinct. An ambiguous settlement is never blindly retried because a storage write may already have been applied even when its acknowledgement was lost.

The repository also exercises the adapter through the official SDK `Client + createMcpHandler` in-process path so SDK error/result conversion is covered in addition to direct wrapper tests.

## Future multi-budget admission

A production SaaS commonly needs several constraints at once, for example user monthly credits, daily credits, tenant monthly credits, and burst/concurrency controls.

The current pre-alpha store has one budget per reservation. Multi-budget atomic admission is planned before v0.1 so all applicable budgets succeed or fail as one transaction.