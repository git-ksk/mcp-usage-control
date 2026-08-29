# mcp-usage-control-redis

Atomic Redis store for `mcp-usage-control`.

> **Current distribution status:** this package is not published to npm yet. Use the repository checkout or locally packed `mcp-usage-control` + `mcp-usage-control-redis` tarballs. See [Use from source / local tarballs](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.md) / [日本語](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.ja.md).

## English

The current adapter implements all-or-nothing multi-budget reserve, pending -> cost-liable activation, renewal, settlement, state-dependent expiry recovery, bounded replay tombstones, and optional recovery observability with Redis-side Lua.

Lease/tombstone timestamps come from Redis server `TIME`, not application `Date.now()`. One global lease index ensures an expired reservation affecting several budgets is recovered once. Transactional state intentionally shares one configurable Redis Cluster hash slot.

Pending expiry releases every participating budget. Cost-liable expiry conservatively keeps the full charge. Identical settlement replay is idempotent; conflicting replay fails. The logical replay scope is `(tenantId, principal.id, tool, operationId)`.

Pass the same optional `UsageObserver` to `RedisUsageStore` and `UsageControl` when you want store-level expiry recovery plus runtime lifecycle events. Redis lazy cleanup reports aggregate recovery counts/units and does not persist raw principal, tenant, tool, or budget strings solely for telemetry.

- [Current source/tarball usage](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.md)
- [Redis adapter](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/redis.md)
- [Observability](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/observability.md)
- [Getting started](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/getting-started.md)
- [API reference](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/api-reference.md)
- [Architecture](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/architecture.md)

Lua atomicity is not persistence/failover durability. Review HA, persistence, cleanup backlog, acknowledgement ambiguity, and single-slot scaling trade-offs before production use.

## 日本語

current adapterはRedis-side Luaでall-or-nothing multi-budget reserve、pending -> cost-liable activation、renewal、settlement、state-dependent expiry recovery、bounded replay tombstone、optionalなrecovery observabilityを実装します。

lease / tombstone時刻はapplication `Date.now()` ではなくRedis server `TIME` を使います。global lease indexを1つ使うため、複数budgetに影響するexpired reservationを1回だけrecoveryします。transactional stateは意図的に1つのconfigurable Redis Cluster hash slotを共有します。

pending expiryは参加する全budgetを解放し、cost-liable expiryはfull chargeを保守的に維持します。identical settlement replayはidempotent、conflicting replayはfailします。logical replay scopeは `(tenantId, principal.id, tool, operationId)` です。

store-level expiry recoveryとruntime lifecycle eventの両方が必要なら、同じoptional `UsageObserver` を `RedisUsageStore` と `UsageControl` に渡します。Redis lazy cleanupはrecovery件数/unitsをaggregateして通知し、telemetryのためだけにraw principal、tenant、tool、budget stringを永続化しません。

- [現在のsource / tarball利用手順](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.ja.md)
- [Redis adapter](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/redis.ja.md)
- [Observability](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/observability.ja.md)
- [Getting started](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/getting-started.ja.md)
- [API reference](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/api-reference.ja.md)
- [Architecture](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/architecture.ja.md)

Lua atomicityはpersistence / failover durabilityと同一ではありません。production利用前にHA、persistence、cleanup backlog、ACK ambiguity、single-slot scaling trade-offを確認してください。

## Operation reconciliation (v0.8)

`RedisUsageStore` implements optional scalar `OperationReconciliationStore` through a read-only Lua lookup. Expected retained units/budget identities must match or the lookup fails closed. Real-Redis CI runs the portable reconciliation conformance suite.

## Atomic vector usage (v0.7)

`RedisUsageStore` implements optional `VectorUsageStore` with vector-specific Lua transactions. Existing mode-less reservation JSON remains scalar; vector metadata is additive and requires no key/balance migration. Real-Redis integration covers portable vector conformance and committed-growth acknowledgement-loss replay.
