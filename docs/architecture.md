# Architecture — v0.1

[English](architecture.md) | [日本語](architecture.ja.md)

## Scope

`mcp-usage-control` owns the enforcement boundary between a trusted accounting principal and metered tool execution:

```text
identity -> entitlement/policy -> quote -> atomic reserve -> mark liable -> execute -> settle
                                                          ^                 |
                                                          |------ renew -----|
```

Its category is **transactional usage/quota enforcement**: admission, liability, lease recovery, and settlement around execution.

It does not own authentication, subscription billing, payment collection, dashboards, generic rate limiting, gateway routing, or upstream pricing.

External billing/metering integrations sit outside the enforcement transaction:

```text
transactional enforcement core -> stable observer/event contract -> optional billing/telemetry adapter
```

An external schema may consume stable outcomes, but it must not redefine or weaken reserve/liability/idempotency/expiry/settlement semantics.

## Why reserve before execution

`check -> execute -> record` has a time-of-check/time-of-use race. Concurrent agent calls can all observe the same remaining balance and start before any one call records usage.

For example, with 1 unit left, two requests can both read `remaining = 1`, both execute a metered upstream operation, and only then increment usage. Two units of real work have been admitted against one unit of capacity.

`UsageStore.reserve()` therefore performs duplicate detection, quota comparison, and reservation creation as one atomic store operation **before** execution. This is the primary distinction from an ordinary request rate limiter.

## Multi-budget admission

A policy can apply several budgets to one invocation, for example:

```text
user daily
user monthly
tenant monthly
```

v0.1 uses one unit quote for the invocation and reserves that amount against **every participating budget atomically**. A production store must provide all-or-nothing semantics: if any budget denies, no other participating budget may be left partially reserved.

Budget keys are canonicalized before admission. Empty budget lists and duplicate budget keys are rejected. The one-budget `budget` quote form is normalized to a one-element budget list.

Burst rate limits and concurrency caps are separate concerns in v0.1 unless an application models them explicitly as usage budgets.

## Pending vs cost-liable leases

A reservation begins **pending**: capacity is reserved, but the metered execution boundary has not yet been entered.

Before metered work begins, call `UsageLease.markLiable()`. The MCP adapter does this immediately before application handler entry.

Expiry behavior is state-dependent:

- **pending expiry** — release the reservation from every participating budget and remove active replay protection for that abandoned operation;
- **cost-liable expiry** — retain the full reservation across every participating budget, settle with `lease_expired_after_execution_started`, and keep replay protection through the idempotency tombstone period.

This closes the crash-after-cost refund gap. The generic MCP wrapper uses handler entry as the liability boundary because it cannot know a provider-specific point of cost. This can conservatively over-account a crash between handler entry and real upstream cost; applications needing a more precise boundary should use the core lifecycle directly.

## Renewable and resumable leases

A fixed reservation TTL is unsafe for legitimate long-running work. If an active reservation is reclaimed while its operation is still running, another operation can reuse the same budget capacity.

`UsageStore.renew()` atomically extends an active lease. `mcp-usage-control-mcp` enables a heartbeat by default while a wrapped handler runs and stops/waits for any in-flight renewal before settlement or multi-round suspension.

`UsageLease.toResumeState()` and `UsageControl.resumeLease()` provide a trusted server-side reattachment mechanism without running policy quote or reserve again. The raw resume state is not a client credential and must not be treated as one.

A storage/network partition can still outlive a lease. Renewal is not provider-specific fencing. Applications requiring immediate cancellation after lease loss must implement fencing/cancellation at the metered resource boundary.

## Settlement, not rollback

A tool can fail after consuming a metered resource. Automatically refunding all errors creates an abuse path.

v0.1 settlement rules are explicit:

- successful work -> settle actual consumed units;
- proven pre-cost failure -> zero is allowed;
- post-cost failure -> settle incurred units;
- unclassified MCP failure -> full reservation by default;
- cost classifier failure -> full reservation is settled before `UsageClassificationError` is surfaced.

`actualUnits` must be a non-negative safe integer and cannot exceed `reservedUnits`. Dynamic-cost tools should reserve a safe maximum and release unused units at settlement.

Settlement applies the same actual unit count to all budgets that participated in the reservation.

## Failure, crash, and acknowledgement ambiguity

State-changing operations can succeed remotely even when the caller does not receive the acknowledgement. The safe response depends on which transition became ambiguous.

### Crash before liability

If a process disappears while a lease is still pending, expiry releases the reservation. No metered execution boundary was declared.

### Crash after liability

If the process disappears after `markLiable()`, expiry retains the full reserved charge. The system cannot safely infer that no metered resource was consumed.

### Lost reserve acknowledgement

A timeout after `reserve()` can mean either "not committed" or "committed but ACK lost". A client must not issue an unrelated second reservation to regain availability. Store-specific reconciliation or stable logical-operation replay should determine whether the original reservation exists.

### Lost settlement acknowledgement

A timeout after `settle()` can likewise mean the settlement committed. Blindly issuing a different settlement is unsafe. Identical settlement replay is idempotent during tombstone retention; conflicting replay fails closed.

### Multi-round post-claim failure

MCP `input_required` resume tokens are consumed once before application re-entry. If a process or transport fails after that claim, the wrapper does not blindly re-enter the application handler. The usage lease remains conservative; applications that need replay of a completed business result require a separate business-idempotency/result-reconciliation layer.

These cases are why the runtime is a state machine rather than a request counter.

## Idempotency and replay protection

The v0.1 logical operation scope is:

```text
(tenantId, principal.id, tool, operationId)
```

`operationId` is application-provided and must be stable across retries of the same logical invocation. It is not authentication proof.

Identifiers are encoded as an unambiguous tuple before hashing/storage so delimiter-containing values do not collide.

Active operations reject duplicate reservation attempts. Settled operations remain protected by a bounded tombstone period; Memory and Redis stores default to 24 hours. After tombstone expiry, the same operation ID may be reused in the same scope.

Settlement replay is separately idempotent: identical `actualUnits` + `outcome` returns the previous settlement; a conflicting replay fails.

## Store contract

Core is independent of MCP and storage vendors. A production `UsageStore` must provide:

- all-or-nothing atomic multi-budget reserve;
- atomic pending -> cost-liable transition;
- atomic active-lease renewal;
- atomic settlement and release across all budgets;
- exactly-once-style expiry recovery for one reservation even when it affects several budgets;
- scoped duplicate-operation protection;
- bounded settled replay retention;
- conservative behavior on ambiguous storage failures.

`MemoryUsageStore` is the reference semantics, not a distributed production store.

`mcp-usage-control-redis` implements the contract with Redis-side Lua in one configurable Redis Cluster hash slot. Lease/tombstone decisions use Redis server `TIME` so application host clock skew does not change accounting.

A future third-party-store compatibility kit should execute these invariants directly so an adapter cannot claim compatibility based only on matching method names.

## Enforcement state vs financial ledger

Atomic enforcement state answers whether work may proceed and how reserved capacity is finalized. That does not automatically make it a financial-grade ledger.

Redis, Durable Objects, or another enforcement store can have persistence/failover properties different from an accounting system used for invoices or statutory records. When stronger durability is required, keep the enforcement state authoritative for admission and reconcile stable enforcement outcomes to a separate durable ledger/event system.

The reconciliation path is downstream; a billing ledger must not become a dynamic fallback quota store after an enforcement-store failure, because split sources of truth can oversubscribe quota.

## MCP result semantics

`mcp-usage-control-mcp` targets `@modelcontextprotocol/server` v2 while core remains SDK-independent.

The adapter distinguishes:

- normal result;
- explicit `{ isError: true }` tool result;
- thrown execution error;
- cost-classification error;
- settlement error;
- explicit multi-round `input_required` suspension/resumption through `protectMultiRoundTool()`.

Ambiguous settlement is not blindly retried because the store write may already have committed even when the acknowledgement was lost.

The repository tests both wrappers directly and through the official SDK `Client + createMcpHandler` path.

### `input_required`

`protectTool()` deliberately remains single-round and conservatively rejects `input_required`.

`protectMultiRoundTool()` provides the opt-in multi-round contract. The initial round reserves and marks liability once. Suspended state remains server-side; the wire `requestState` is an integrity-protected opaque reference. Resume requires the MCP server verification hook plus an atomic principal/tool/args binding-aware flow consume. The resumed round reattaches to the original lease instead of re-quoting or re-reserving.

`MemoryMcpUsageFlowStore` is process-local reference semantics. Horizontally scaled servers need a shared/durable flow store with the same atomic compare-and-consume contract. Completed-result replay after a post-claim crash remains a separate reconciliation concern rather than a reason to weaken one-time resume-token semantics.

## Trust boundaries

- principal/tenant identity must come from trusted server-side authentication/application context;
- `clientInfo`, tool arguments, request-state blobs, and operation IDs are not authorization proof;
- MCP client-round-tripped request state must be integrity-verified and rebound to trusted server-side flow state before it can affect accounting;
- policy denial details should not contain secrets intended for end users/models;
- budget keys and outcome labels should be low-cardinality and non-sensitive when exported to logs/metrics;
- hashing reduces identifier exposure in storage/key names but is not encryption;
- external billing/metering adapters may observe stable outcomes but must not alter enforcement decisions or transaction semantics.
