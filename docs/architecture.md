# Architecture — v0.1

[English](architecture.md) | [日本語](architecture.ja.md)

## Scope

`mcp-usage-control` owns the enforcement boundary between a trusted accounting principal and metered tool execution:

```text
identity -> entitlement/policy -> quote -> atomic reserve -> mark liable -> execute -> settle
                                                          ^                 |
                                                          |------ renew -----|
```

It does not own authentication, subscription billing, payment collection, dashboards, generic rate limiting, or upstream pricing.

## Why reserve before execution

`check -> execute -> record` has a time-of-check/time-of-use race. Concurrent agent calls can all observe the same remaining balance and start before any one call records usage.

`UsageStore.reserve()` therefore performs duplicate detection, quota comparison, and reservation creation as one atomic store operation.

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

## Renewable leases

A fixed reservation TTL is unsafe for legitimate long-running work. If an active reservation is reclaimed while its operation is still running, another operation can reuse the same budget capacity.

`UsageStore.renew()` atomically extends an active lease. `mcp-usage-control-mcp` enables a heartbeat by default while a wrapped handler runs and stops/waits for any in-flight renewal before settlement.

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

## Redis atomicity vs durability

Lua provides atomic transitions inside Redis. It does not by itself guarantee persistence across every crash, failover, or acknowledged-write-loss window. Production deployments must configure persistence, replication, failover, backup, and recovery according to their acceptable accounting-loss budget.

When a stronger financial ledger is required, Redis should remain the enforcement state and be reconciled to a separate durable ledger/event system.

## MCP result semantics

`mcp-usage-control-mcp` targets `@modelcontextprotocol/server` v2 **single-round** tool handlers while core remains SDK-independent.

The adapter distinguishes:

- normal result;
- explicit `{ isError: true }` tool result;
- thrown execution error;
- cost-classification error;
- settlement error.

Ambiguous settlement is not blindly retried because the store write may already have committed even when the acknowledgement was lost.

The repository tests both the wrapper directly and through the official SDK `Client + createMcpHandler` path.

### `input_required`

MCP v2 `input_required` crosses request boundaries. Correct accounting requires reservation suspend/resume semantics, replay identity across rounds, abandonment recovery, and integrity rules for client-carried state.

v0.1 therefore makes an explicit support-boundary decision: `protectTool()` does **not** support `input_required`. If a wrapped handler returns it, the current reservation is conservatively settled and `UnsupportedMcpUsageFlowError` is surfaced. True suspend/resume support remains tracked in issue #14.

## Trust boundaries

- principal/tenant identity must come from trusted server-side authentication/application context;
- `clientInfo`, tool arguments, request-state blobs, and operation IDs are not authorization proof;
- policy denial details should not contain secrets intended for end users/models;
- budget keys and outcome labels should be low-cardinality and non-sensitive when exported to logs/metrics;
- Redis hashing reduces identifier exposure in key names but is not encryption.
