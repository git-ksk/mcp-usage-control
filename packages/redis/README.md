# mcp-usage-control-redis

Atomic Redis store for `mcp-usage-control`.

```console
npm install mcp-usage-control-redis redis
```

## English

v0.1 implements all-or-nothing multi-budget reserve, pending -> cost-liable activation, renewal, settlement, state-dependent expiry recovery, and bounded replay tombstones with Redis-side Lua.

Lease/tombstone timestamps come from Redis server `TIME`, not application `Date.now()`. One global lease index ensures an expired reservation affecting several budgets is recovered once. Transactional state intentionally shares one configurable Redis Cluster hash slot.

Pending expiry releases every participating budget. Cost-liable expiry conservatively keeps the full charge. Identical settlement replay is idempotent; conflicting replay fails. The logical replay scope is `(tenantId, principal.id, tool, operationId)`.

- [Redis adapter](../../docs/redis.md)
- [Getting started](../../docs/getting-started.md)
- [API reference](../../docs/api-reference.md)
- [Architecture](../../docs/architecture.md)

Lua atomicity is not persistence/failover durability. Review HA, persistence, cleanup backlog, acknowledgement ambiguity, and single-slot scaling trade-offs before production use.

## 日本語

v0.1はRedis-side Luaでall-or-nothing multi-budget reserve、pending -> cost-liable activation、renewal、settlement、state-dependent expiry recovery、bounded replay tombstoneを実装します。

lease / tombstone時刻はapplication `Date.now()` ではなくRedis server `TIME` を使います。global lease indexを1つ使うため、複数budgetに影響するexpired reservationを1回だけrecoveryします。transactional stateは意図的に1つのconfigurable Redis Cluster hash slotを共有します。

pending expiryは参加する全budgetを解放し、cost-liable expiryはfull chargeを保守的に維持します。identical settlement replayはidempotent、conflicting replayはfailします。logical replay scopeは `(tenantId, principal.id, tool, operationId)` です。

- [Redis adapter](../../docs/redis.ja.md)
- [Getting started](../../docs/getting-started.ja.md)
- [API reference](../../docs/api-reference.ja.md)
- [Architecture](../../docs/architecture.ja.md)

Lua atomicityはpersistence / failover durabilityと同一ではありません。production利用前にHA、persistence、cleanup backlog、ACK ambiguity、single-slot scaling trade-offを確認してください。
