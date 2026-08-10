# @mcp-usage-control/redis

> Pre-alpha. This workspace package is currently private and not published to npm.

## English

Production-oriented `UsageStore` adapter backed by Redis-side Lua transitions for atomic reserve, pending -> cost-liable activation, renew, settlement, state-dependent expiry recovery, and idempotency state.

Lease/tombstone timestamps are computed from Redis server time inside Lua rather than application `Date.now()`. Expired pending reservations release capacity; expired cost-liable reservations conservatively retain the full charge.

- [Redis adapter](../../docs/redis.md)
- [Getting started](../../docs/getting-started.md)
- [API reference](../../docs/api-reference.md)
- [Architecture](../../docs/architecture.md)

The adapter intentionally uses one configurable Redis Cluster hash slot for transactional state. Lua atomicity is not the same as persistence/failover durability; review the documented HA, durability, cleanup-backlog, and scaling trade-offs before production use.

## 日本語

Redis-side Lua transitionでatomic reserve、pending -> cost-liable activation、renew、settlement、state-dependent expiry recovery、idempotency stateを実装するproduction-oriented `UsageStore` adapterです。

lease / tombstone timestampはapplication `Date.now()` ではなくLua内のRedis server timeから計算します。expired pending reservationはcapacityを解放し、expired cost-liable reservationはfull chargeを保守的に維持します。

- [Redis adapter](../../docs/redis.ja.md)
- [Getting started](../../docs/getting-started.ja.md)
- [API reference](../../docs/api-reference.ja.md)
- [Architecture](../../docs/architecture.ja.md)

transactional stateは意図的に1つのconfigurable Redis Cluster hash slotへ置きます。Lua atomicityとpersistence / failover durabilityは同じではありません。production利用前にHA、durability、cleanup backlog、scaling trade-offを確認してください。