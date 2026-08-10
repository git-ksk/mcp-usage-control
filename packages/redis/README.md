# @mcp-usage-control/redis

> Pre-alpha. This workspace package is currently private and not published to npm.

## English

Production `UsageStore` adapter backed by Redis-side Lua transitions for atomic reserve, renew, settlement, expiry recovery, and idempotency state.

- [Redis adapter](../../docs/redis.md)
- [Getting started](../../docs/getting-started.md)
- [API reference](../../docs/api-reference.md)
- [Architecture](../../docs/architecture.md)

The current adapter intentionally uses one configurable Redis Cluster hash slot for its transactional state. Review the documented scaling and failure trade-offs before production use.

## 日本語

Redis-side Lua transitionでatomic reserve、renew、settlement、expiry recovery、idempotency stateを実装するproduction `UsageStore` adapterです。

- [Redis adapter](../../docs/redis.ja.md)
- [Getting started](../../docs/getting-started.ja.md)
- [API reference](../../docs/api-reference.ja.md)
- [Architecture](../../docs/architecture.ja.md)

現在のadapterはtransactional stateを1つのconfigurable Redis Cluster hash slotへ置きます。production利用前にdocumented scaling / failure trade-offを確認してください。