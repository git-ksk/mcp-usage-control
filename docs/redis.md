# Redis adapter

[English](redis.md) | [日本語](redis.ja.md)

`@mcp-usage-control/redis` is the first production-store adapter for `mcp-usage-control`.

The current pre-alpha implementation is tested in CI with Redis 7 and Node.js 20/22. It uses the public `eval(script, { keys, arguments })` shape provided by node-redis; the workspace currently tests against `redis` 6.2.x.

## Atomicity model

Admission is not implemented as `GET -> compare -> SET`. Redis-side Lua performs the state transition atomically:

1. reclaim a bounded batch of expired reservations for the target budget;
2. clean a bounded batch of expired idempotency tombstones;
3. reject a duplicate principal/operation ID;
4. compare current usage with the budget limit;
5. reserve units and create a pending lease.

`markLiable`, renewal and settlement are separate atomic Lua transitions. Settlement is idempotent for an identical replay and rejects a conflicting replay.

## Pending and cost-liable expiry

A new reservation is `pending`. If it expires before being marked cost-liable, Redis releases its reserved units and removes the operation record.

Once `markLiable()` succeeds, expiry is conservative. Redis keeps the full reserved units charged, converts the record to settled with outcome `lease_expired_after_execution_started`, and retains replay protection through the normal tombstone mechanism.

This means a process crash after entering the metered execution boundary does not become an automatic refund. It also means the generic MCP adapter can over-account if the process dies after handler entry but before real provider cost occurs; that is the deliberate safe default.

## Redis server time

Lease creation, renewal, expiry checks and tombstone expiry use Redis server time from the Lua script itself. The adapter does not use application `Date.now()` for those transitions.

This avoids changing accounting behavior because two application instances have clock skew or because a request spends significant time in the network before Redis executes the script.

## Redis Cluster hash slot

All transactional keys deliberately share one configurable hash tag. With the defaults, keys contain `{usage}`.

This keeps reserve/mark-liable/renew/settle scripts valid on Redis Cluster and leaves room for future multi-budget transactions without `CROSSSLOT` failures. The trade-off is that the current design concentrates usage-control writes in one Redis Cluster slot.

Correctness is the default. A future sharding strategy may allow multiple usage-control shards, but every budget participating in one atomic admission still needs a common transaction domain.

## Key model

Raw principal IDs, operation IDs, and budget keys are not embedded into Redis key names. Principal and operation IDs are first encoded as an unambiguous tuple and then SHA-256 hashed; budget keys are hashed separately.

Conceptually, the state is:

```text
<prefix>:{<hashTag>}:budget:<budgetHash>:used
<prefix>:{<hashTag>}:budget:<budgetHash>:pending
<prefix>:{<hashTag>}:reservations
<prefix>:{<hashTag>}:operations
<prefix>:{<hashTag>}:tombstones
```

Reservation records contain hashed operation identifiers, unit counts, lease expiry, state, and settlement outcome. Keep `outcome` values low-cardinality and non-sensitive.

## Lease heartbeat and partitions

The MCP adapter renews active leases by default while a single-round tool handler is running. Applications using core/Redis directly must renew long-running reservations themselves.

A network partition can still outlive a distributed lease. While Redis is unavailable, adapter calls propagate the storage error rather than failing open for new admission. The generic heartbeat does not fence arbitrary upstream resources. Because execution-started leases are cost-liable, expiry charges conservatively instead of refunding them.

## Idempotency tombstones

Settled operation IDs remain protected from replay for `idempotencyTtlMs` (24 hours by default). Cleanup is lazy and batch-limited, so expired state may remain longer when no new admissions arrive. That is safe: stale state can delay reuse but does not grant extra quota.

## Lazy cleanup backlog

`cleanupBatchSize` bounds the amount of expiry/tombstone work done by one admission. If a budget accumulates more expired reservations than one cleanup batch, stale reserved units can temporarily cause a conservative denial until later admissions drain the backlog.

This is an availability trade-off, not a quota-bypass path. Operators with unusually high crash/expiry volume should size `cleanupBatchSize` appropriately and monitor stale-state pressure. A future implementation may add dedicated maintenance/reconciliation without weakening atomic admission.

## Budget key lifecycle

The adapter does **not** guess when a budget window should reset. The policy should use window-qualified keys, for example:

```text
month:user-123:2026-08
day:user-123:2026-08-10
```

Changing the budget key starts a new accounting window. Old `used` keys are intentionally not given a potentially unsafe automatic TTL by the adapter. Operators with many historical windows should apply a retention policy appropriate to their own budget-key scheme.

## Atomicity is not durability

The Lua scripts provide atomic state transitions inside Redis. They do **not** by themselves guarantee that an acknowledged write survives every process crash, host failure, failover, or persistence configuration.

For production enforcement, choose Redis persistence and HA settings that match the application's tolerance for lost accounting state. In particular, evaluate:

- whether persistence is enabled;
- RDB/AOF policy and acceptable loss window;
- replication and failover behavior;
- backup/recovery procedures;
- whether the chosen Redis service can lose an acknowledged write during failover.

If the business requires a stronger durable financial ledger, treat Redis usage state as the enforcement layer and reconcile to a separate durable ledger/event system. Do not infer financial-grade durability merely from Lua atomicity.

## Failure behavior

Redis errors are propagated rather than converted to an allow decision. An admission or mark-liable write can succeed even if the client loses the acknowledgement; retrying the same logical invocation with the same operation ID prevents a second reservation, and a mark-liable ambiguity remains conservative on expiry.

Settlement has the same acknowledgement ambiguity. Identical settlement replay is idempotent; a replay with different actual units or outcome is rejected as a conflict.

CI fault-injection tests exercise real Redis behavior for 100-way concurrent admission, pending expiry recovery, liable crash recovery, renewal, settlement replay/conflict, tombstone expiry, lost acknowledgements after writes, and independence from the application clock.

## Configuration

- `prefix`: key prefix for usage-control state. Redis hash-tag braces are rejected.
- `hashTag`: the hash tag used to keep transactional keys in one Redis Cluster slot.
- `cleanupBatchSize`: maximum expired reservation/tombstone cleanup work performed by one reserve call.
- `idempotencyTtlMs`: retention period for settled operation replay protection.

Processes participating in the same logical usage domain must use compatible prefix/hash-tag settings. Different settings create separate accounting state.

## Current limits

- one budget per reservation; atomic multi-budget admission is tracked separately;
- settlement requires `actualUnits <= reservedUnits`;
- cleanup is lazy and bounded per admission;
- Redis durability policy is deployment-specific, not enforced by the adapter;
- no built-in billing, payment, authentication, or analytics backend.