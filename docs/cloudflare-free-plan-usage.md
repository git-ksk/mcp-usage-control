# Cloudflare platform usage / Free-plan operations

[English](cloudflare-free-plan-usage.md) | [日本語](cloudflare-free-plan-usage.ja.md)

Cloudflare Durable Objects limits are platform operations, not MCP tool calls. A protected tool invocation normally performs several `UsageStore` transitions, and each remote Cloudflare transition becomes one authenticated gateway request followed by one Durable Object method invocation.

Do not use Cloudflare billing/usage counters as the source of quota truth. `mcp-usage-control` state remains the enforcement source of truth.

## Store-operation shape

Representative remote operation counts are:

| Logical path | Usage-store operations | Remote gateway / DO invocations |
| --- | --- | ---: |
| reserve denied by business quota | `reserve` | 1 |
| reserve accepted, then cancelled before metered work | `reserve -> settle` | 2 |
| normal protected success | `reserve -> markLiable -> settle` | 3 |
| long-running protected success with N heartbeats | `reserve -> markLiable -> renew × N -> settle` | `3 + N` |
| identical settlement reconciliation after a lost ACK | normal path plus replayed `settle` | +1 per reconciliation attempt |
| ambiguous reserve retry chosen by the application | normal path plus repeated `reserve` | +1 per retry attempt |

Authentication/validation failures can stop at the Worker gateway and therefore need not reach the Durable Object.

The deployed integration suite is intentionally larger than one normal tool call: the 100-way contention case dominates it, and a full run performs roughly 130 authenticated store operations plus authentication probes.

## SQLite work per operation

Cloudflare bills SQLite activity in rows read/written. The exact billed row count depends on query results, indexes, the number of participating budgets, and any lazy recovery performed during the request, so the adapter does not expose a fake 1-call-to-N-rows constant.

The implementation shape is deterministic enough for capacity estimation. Let `B` be the number of budgets participating in one reservation.

### `reserve`

Baseline work includes:

- a bounded expired-reservation cleanup scan and settled-tombstone delete;
- one duplicate-reservation lookup;
- one budget-balance lookup per budget (`B` reads at the logical SQL-query level).

If accepted, it additionally performs:

- one budget upsert per budget (`B` writes at the logical SQL-statement level);
- one reservation insert.

A denied reserve does not perform the admission budget/reservation writes, although bounded lazy cleanup may already have performed recovery work.

### `markLiable`

Baseline work includes a direct-expiry recovery lookup, reservation state lookup, and — when the reservation is pending — one reservation-state update.

### `renew`

Baseline work includes a direct-expiry recovery lookup, reservation state lookup, and one lease-expiry update.

Every heartbeat therefore adds another remote gateway request, Durable Object invocation, and SQLite transaction.

### `settle`

Baseline work includes a direct-expiry recovery lookup and reservation state lookup. A first successful settlement updates the reservation tombstone. If unused units are released, it also updates every participating budget (`B` budget updates).

An identical settlement replay is idempotent and is primarily a lookup/reconciliation path; it does not reserve quota again.

### Recovery amplification

Lazy recovery is bounded, but it can add work to a later `reserve`:

- expired pending reservation: update each participating budget to release its reserved units, then delete the reservation;
- expired liable reservation: conservatively retain the charge and convert the reservation into a settled tombstone;
- expired settled tombstones: bounded deletion.

This is why a workload with many crashes/abandoned leases can consume more SQLite operations than a healthy steady-state workload.

## Free-plan operating guidance

Workers Free supports SQLite-backed Durable Objects. Cloudflare publishes the current request/compute/storage/SQLite limits in its Durable Objects pricing documentation; consult those current values rather than copying a permanent numeric assumption into application enforcement.

Operationally:

1. Estimate protected-call volume using the store-operation table above.
2. Add expected heartbeat volume for long-running tools.
3. Add headroom for retries/reconciliation and bounded expiry recovery.
4. Observe Worker / Durable Object request and SQLite metrics at the platform level.
5. Use `UsageObserver` for provider-neutral lifecycle counters such as `reserve.accepted`, `reserve.denied`, `settlement.completed`, `reservation.recovered`, and `operation.error`.
6. Keep unique principal/operation/reservation IDs out of metric labels.

Cloudflare Free-plan limit exhaustion must not silently become a business quota denial. Current Cloudflare behavior is that further operations of a type fail after that Free-tier limit is exceeded until the applicable limit resets. Treat this as platform unavailability.

## Platform failure vs business quota denial

These are intentionally different paths:

- **Business quota denial:** the Durable Object returns a successful protocol envelope with `accepted: false`, `reason: 'quota_exceeded'`. The remote caller receives a normal `StoreReserveResult` and may present a quota-specific response.
- **Cloudflare / Durable Object failure:** the gateway converts an internal invocation failure to HTTP `503` without serializing the raw runtime exception. `RemoteCloudflareUsageStore` converts a non-success HTTP status to `CloudflareUsageTransportError` with code `remote`. The caller fails closed. The error may expose only bounded numeric `status` metadata such as `429` or `503`; the remote response body is not propagated.
- **Network/timeout ambiguity:** the remote client reports `network` or `timeout` and does not blindly retry. `timeoutMs` is a full-call deadline covering rotating-header resolution, fetch, and response-body/protocol decoding.

Do not dynamically switch to a second quota ledger after a Cloudflare platform failure. Doing so would create split enforcement truth and can permit quota oversubscription.

## Observability mapping

Provider-neutral events already support bounded operational views:

- `reserve.accepted` / `reserve.denied`: admitted and denied logical operations;
- `settlement.completed`: completed settlement/reconciliation calls;
- `reservation.recovered`: aggregate pending-release / liable-retained recovery activity from Cloudflare;
- `operation.error`: store/runtime failures by phase and bounded error class.

Successful `markLiable` and `renew` are intentionally not promoted into unique-ID metrics by the core event stream. Their backend volume is deterministic from the lifecycle and heartbeat configuration and can be measured at the Worker/Durable Object request layer when exact platform-call counts are needed.

See also [Cloudflare adapter](cloudflare.md), [Observability](observability.md), and [deployed E2E runbook](cloudflare-deployed-e2e.md).
