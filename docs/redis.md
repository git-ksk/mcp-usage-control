# Redis adapter

`@mcp-usage-control/redis` is the first production-store adapter for `mcp-usage-control`.

The current pre-alpha implementation is tested in CI with Redis 7 and Node.js 20/22. It uses the public `eval(script, { keys, arguments })` shape provided by node-redis; the workspace currently tests against `redis` 6.2.x.

## Atomicity model

Admission is not implemented as `GET -> compare -> SET`. A Lua script performs these steps as one Redis transaction boundary:

1. reclaim a bounded batch of expired pending reservations for the target budget;
2. clean a bounded batch of expired idempotency tombstones;
3. reject a duplicate principal/operation ID;
4. compare current usage with the budget limit;
5. reserve units and create the pending lease.

Renewal and settlement are separate atomic Lua transitions. Settlement is idempotent for an identical replay and rejects a conflicting replay.

## Redis Cluster hash slot

All transactional keys deliberately share one configurable hash tag. With the defaults, keys contain `{usage}`.

This means reserve/renew/settle scripts stay valid on Redis Cluster and leaves room for future multi-budget transactions without `CROSSSLOT` failures. The trade-off is that v0.1 concentrates usage-control writes in one Redis Cluster slot.

Correctness is the default. A future sharding strategy may allow multiple usage-control shards, but every budget participating in one atomic admission will still need a common transaction domain.

## Key model

Raw principal IDs, operation IDs, and budget keys are not embedded into Redis key names. The adapter derives SHA-256 identifiers in the process before calling Redis.

Conceptually, the state is:

```text
<prefix>:{<hashTag>}:budget:<budgetHash>:used
<prefix>:{<hashTag>}:budget:<budgetHash>:pending
<prefix>:{<hashTag>}:reservations
<prefix>:{<hashTag>}:operations
<prefix>:{<hashTag>}:tombstones
```

Reservation records contain hashed operation identifiers, unit counts, lease expiry, state, and settlement outcome. Keep `outcome` values low-cardinality and non-sensitive.

## Lease expiry and heartbeat

Expired pending reservations are reclaimed lazily during subsequent admission. This avoids relying on Redis key-expiry notifications for accounting side effects.

The MCP adapter renews active leases by default while a tool handler is running. Applications using core/Redis directly must renew long-running reservations themselves.

A network partition can still outlive any distributed lease. While Redis is unavailable, adapter calls propagate the storage error rather than failing open. See [Architecture](architecture.md) for the distributed-lease limitation.

## Idempotency tombstones

Settled operation IDs remain protected from replay for `idempotencyTtlMs` (24 hours by default). Cleanup is lazy and batch-limited, so expired state may remain longer when no new admissions arrive. That is safe: stale state can delay reuse but does not grant extra quota.

## Budget key lifecycle

The adapter does **not** guess when a budget window should reset. The policy should use window-qualified keys, for example:

```text
month:user-123:2026-08
day:user-123:2026-08-10
```

Changing the budget key starts a new accounting window. Old `used` keys are intentionally not given a potentially unsafe automatic TTL by the adapter. Operators with many historical windows should apply a retention policy appropriate to their own budget-key scheme.

## Current limits

- one budget per reservation; atomic multi-budget admission is tracked separately;
- settlement requires `actualUnits <= reservedUnits`;
- cleanup is lazy and bounded per admission;
- no built-in billing, payment, authentication, or analytics backend.
