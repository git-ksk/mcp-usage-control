# Redis adapter — current source

[English](redis.md) | [日本語](redis.ja.md)

`mcp-usage-control-redis` is the distributed production-store adapter for `mcp-usage-control`.

> **Current distribution status:** the package is not published to npm yet. Build/install the local core + Redis tarballs as described in [Use from source / local tarballs](using-from-source.md), together with `redis@6.2.0`.

The v0.8 source line is tested with Redis 7 and node-redis 6.2.x. The release matrix currently exercises Node.js 20/22/24; the supported Node.js floor for the future v1 line is intentionally decided in v0.10 (#105) rather than inferred from compatibility CI.

## Atomic multi-budget model

Admission is not `GET -> compare -> SET`, and multi-budget admission is not a client-side loop.

One Lua script:

1. reclaims a bounded batch of expired leases exactly once per reservation;
2. cleans a bounded batch of expired settled tombstones;
3. rejects duplicate `(tenant, principal, tool, operation)` identity;
4. reads every participating budget;
5. returns denial without writes if any budget cannot admit;
6. otherwise increments every budget and creates one pending reservation atomically.

`markLiable`, renewal, settlement, and expiry recovery also operate on the whole reservation, including every participating budget.

This prevents partial reservation/release when an operation participates in daily, monthly, tenant, or other shared budgets.

## v0.1 key model

All transactional keys share one configurable Redis Cluster hash tag. With defaults:

```text
muc:{usage}:used          HASH budgetHash -> used units
muc:{usage}:leases        ZSET reservationId -> active lease expiry
muc:{usage}:reservations  HASH reservationId -> reservation record
muc:{usage}:operations    HASH operationHash -> reservationId
muc:{usage}:tombstones    ZSET operationHash -> settled replay expiry
```

A single global lease index means an expired multi-budget reservation is recovered once instead of being independently discovered through several budget indexes.

Raw principal, tenant, operation, tool, and budget identifiers are not embedded directly into Redis key names. The logical operation tuple is encoded unambiguously and SHA-256 hashed; budget keys are hashed separately. Hashing reduces identifier exposure in key names but is not encryption.

## Redis Cluster transaction domain

All keys above intentionally use one hash slot so every Lua transition is valid on Redis Cluster without `CROSSSLOT` behavior.

Correctness is prioritized over horizontal write distribution in v0.1. A future sharding design may provide several independent usage domains, but all budgets participating in one atomic admission must remain in one transaction domain.

## Pending vs cost-liable expiry

A reservation starts `pending`.

- If it expires before `markLiable()`, Redis releases its reserved units from **every budget**, removes the active operation mapping, and allows the logical operation to be retried after recovery.
- After `markLiable()`, expiry is conservative: every budget keeps the full reserved units, the reservation becomes settled with `lease_expired_after_execution_started`, and replay protection continues through the tombstone period.

This prevents a process crash after entering the metered execution boundary from becoming a refund.

## Redis server time

Reserve, `markLiable`, renew, settle expiry checks, and tombstone expiry use Redis server `TIME` inside Lua. Application `Date.now()` is not used for those enforcement decisions.

This avoids accounting differences caused by application-instance clock skew or network delay between application-time capture and script execution. Operational event timestamps are telemetry and are not used for lease decisions.

## Idempotency

The logical operation scope is:

```text
(tenantId, principal.id, tool, operationId)
```

The tuple is hashed into the Redis operation key. Settled operations stay replay-protected for `idempotencyTtlMs`, default 24 hours.

Identical settlement replay is idempotent. A different actual-unit/outcome replay conflicts.

Tombstone cleanup is lazy and bounded. Expired tombstones may remain longer if no admissions occur; that can delay reuse but does not create extra quota.

## Lease heartbeat and network partitions

The MCP adapter renews a wrapped active lease by default. Core/Redis direct users must renew long-running work themselves.

A network partition can outlive the distributed lease. Redis errors propagate rather than fail open. The generic heartbeat is not upstream-resource fencing. Once the lease is cost-liable, expiry is intentionally conservative.

Applications that must halt work immediately when lease ownership is uncertain need provider-specific cancellation/fencing.

## Recovery observability

Pass an optional `UsageObserver` to `RedisUsageStore` to receive expiry-recovery telemetry. If you also want admission/settlement/error lifecycle events, pass the same observer to `UsageControl`.

Lazy cleanup can recover several expired reservations in one Lua execution. The Redis adapter reports these as aggregate `reservation.recovered` events with:

- `recovery: 'pending_released' | 'liable_retained'`;
- `count`;
- aggregate `reservedUnits`.

Redis intentionally does **not** persist raw principal, tenant, tool, or budget strings solely to make cleanup telemetry more detailed. If an expired reservation is touched directly by `renew`, `markLiable`, or `settle`, the event may include its opaque hashed reservation ID.

Observer delivery is best-effort and outside the Redis transaction. Missing telemetry does not mean recovery/enforcement did not happen, and observer failure never changes Redis state. See [Observability](observability.md).

## Lazy cleanup backlog

`cleanupBatchSize` bounds expired lease/tombstone work per new admission. If stale state exceeds one batch, some stale reservations may survive until later admissions invoke cleanup.

Because v0.1 uses a global lease index, cleanup backlog can conservatively delay capacity recovery across the usage domain. This is an availability trade-off, not a quota bypass.

Operators with high crash/abandonment volume should monitor stale-state pressure and tune `cleanupBatchSize`. Dedicated reconciliation is a possible future addition.

## Budget windows and retention

The adapter does not infer reset dates. Use window-qualified budget keys:

```text
day:user-42:2026-08-10
month:user-42:2026-08
month:tenant-org-7:2026-08
```

Changing the key starts a new accounting bucket. v0.1 does not automatically TTL `used` budget fields because a generic retention policy could erase still-valid accounting state. Applications should implement retention only when their own window lifecycle makes deletion safe.

## Atomicity is not durability

Lua gives atomic Redis transitions. It does **not** mean an acknowledged write survives every crash/failover configuration.

For production enforcement, explicitly review:

- persistence enabled/disabled;
- AOF/RDB configuration and acceptable loss window;
- replication/failover behavior;
- backup/recovery procedures;
- acknowledged-write-loss behavior of the managed Redis service.

For financial-grade durable accounting, use Redis as the enforcement layer and reconcile usage to a separate durable ledger/event stream.

## Acknowledgement ambiguity

A Redis write can commit while the client loses its acknowledgement.

v0.1 behavior is conservative:

- admission ACK loss -> retrying the same logical operation is blocked as duplicate; a different operation observes the reserved capacity;
- `markLiable` ACK loss -> if the write committed, later expiry remains cost-liable and charges conservatively;
- settlement ACK loss -> identical settlement replay is idempotent; conflicting replay fails.

CI fault-injection tests cover these cases against real Redis.

## Configuration

```ts
interface RedisUsageStoreOptions {
  prefix?: string;             // default "muc"
  hashTag?: string;            // default "usage"
  cleanupBatchSize?: number;   // default 256
  idempotencyTtlMs?: number;   // default 86_400_000 (24h)
  observer?: UsageObserver;    // optional best-effort recovery telemetry
}
```

Processes participating in one logical usage domain must use the same compatible prefix/hash-tag configuration. Observer configuration does not participate in Redis transaction identity.

## Tested invariants

CI uses real Redis 7 for:

- 100 concurrent callers with one remaining unit -> exactly one admission;
- 100 different users sharing one tenant budget -> exactly one admission;
- multi-budget denial leaves no partial reservation;
- unused settlement releases all participating budgets;
- pending/liable expiry across all budgets;
- aggregate pending/liable recovery observability and opaque direct-expiry telemetry;
- lease renewal;
- scoped replay protection and tombstone expiry;
- settlement replay/conflict;
- lost admission / mark-liable / settlement acknowledgements;
- Redis server-time independence from the application clock for lease decisions;
- Redis unavailable -> fail closed for admission.

## Current limits

- `actualUnits <= reservedUnits`;
- all budgets in one reservation consume the same quoted/actual unit count;
- one Redis hash slot per configured usage-control transaction domain;
- cleanup is lazy/bounded;
- Redis durability policy remains deployment-specific;
- observability is best-effort/non-durable and not the quota ledger;
- no built-in billing, payment, authentication, or analytics backend.

## Operation reconciliation (v0.8)

`RedisUsageStore` implements optional scalar `OperationReconciliationStore`. The lookup runs one read-only Lua script using Redis `TIME`, `HGET`, and `ZSCORE`; it never reserves/releases capacity or changes liability, lease, settlement, or replay state. Expected reserved units and hashed budget identities must match retained state or the call fails closed.

Real-Redis CI runs the portable operation-reconciliation conformance suite. A settled reservation missing its tombstone index is treated as invalid/indeterminate state rather than being misreported as `absent`.

## Progressive reservation growth (v0.6)

`RedisUsageStore` implements the optional progressive-growth contract. One `GROW_SCRIPT` Lua transaction validates the active reservation, exact original budget-key set, growth cursor, replay identity, and every current budget limit before mutating accounting state.

- accepted growth increments every participating budget and `reservedUnits` atomically;
- quota denial increments none of them, but records the authoritative denied attempt and rotates the growth cursor;
- retry of the same `incrementId` + prior cursor + canonical parameters replays the recorded result without growing twice;
- a different increment on a stale cursor fails closed;
- pending/liable and expiry behavior remains the existing reservation behavior, applied to the full grown total;
- settlement remains bounded by the total successfully reserved capacity;
- settled/expired reservations never return growth success, including replay.

Growth metadata is stored additively inside the existing reservation JSON (`growthCursor` plus latest replay metadata). A reservation written by v0.5 or earlier has no growth cursor: it remains readable/settleable under the fixed-reservation contract but cannot be grown. No Redis key migration, balance rewrite, or reset is required when upgrading to v0.6.

Real-Redis CI runs the portable progressive Store conformance plus a committed-growth acknowledgement-loss case. The retry must use the same stable increment identity; issuing a fresh increment after an ambiguous ACK is forbidden.

## Atomic heterogeneous vector usage (v0.7)

`RedisUsageStore` also implements optional `VectorUsageStore`. Vector reservations add `mode: "vector"`, per-dimension reserved totals, one reservation-wide growth cursor, and vector-growth replay metadata to the existing reservation JSON. Existing mode-less records remain scalar; no Redis key or balance migration is required.

Vector reserve/grow/settle run as single Lua transactions across all participating dimensions and budgets. Pending expiry releases every dimension; liable expiry retains every dimension. Real-Redis CI runs portable vector conformance plus committed-vector-growth acknowledgement-loss replay.
