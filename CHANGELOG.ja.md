# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

主なproject changeを記録します。

## [0.1.0] - 2026-08-10

最初のpublic releaseです。

### Added

- provider-neutralなusage policy / store contractを持つ `mcp-usage-control` core runtime。
- 適用される全budgetをreserveするか、どれもreserveしないatomic **multi-budget** admission。
- `markLiable()` を使うpending -> cost-liable -> settled lifecycle。
- long-running work向けrenewable lease。
- `actualUnits <= reservedUnits` のexplicit outcome-aware settlement。
- `(tenantId, principal.id, tool, operationId)` 単位のreplay protection。
- bounded settled idempotency tombstone。Memory / Redisのdefaultは24時間。
- `MemoryUsageStore` reference implementation。
- admission / settlement / expiry recovery / policy・store error向けprovider-neutral `UsageObserver` lifecycle hook。
- explicit opt-in event metadata。tool arguments / raw exception messageは自動収集しない。
- enforcement stateを変更しないbest-effort / non-blocking observer delivery。
- `@modelcontextprotocol/server` v2 single-round tool向け `mcp-usage-control-mcp` adapter。
- normal success、`{ isError: true }`、thrown errorを区別するMCP result classification。
- classifier failure時のconservative settlementと `UsageClassificationError`。
- ambiguous settlement state向け `UsageSettlementError`。
- v0.1 `input_required` support boundary向け `UnsupportedMcpUsageFlowError`。
- Redis-side Luaでmulti-budget reserve、liability、renew、settlement、expiry recovery、tombstoneをatomicに処理する `mcp-usage-control-redis`。
- Redis server timeによるlease / tombstone判定。
- multi-budget expiryをreservation単位で1回だけ回収するglobal Redis lease index。
- telemetryのためだけにraw request identityを永続化せず、Redis expiry recoveryをaggregate通知するobservability。
- Redis Cluster compatible single-hash-slot transaction domain。
- 実Redis 7 concurrency / crash / ACK-loss / recovery-observability integration test。
- 公式MCP SDK v2 `Client + createMcpHandler` protocol integration test。
- Node.js 20 / 22のfrozen `pnpm-lock.yaml` CI。
- exports / files / license / workspace protocol除去を確認するpackage tarball smoke test。
- 英日user / architecture / Redis / MCP integration / observability / API / release / security / support / contribution docs。

### Safety behavior

- quota compare + reserveをatomic化し、`check -> execute -> record` raceを作らない。
- execution開始後のprocess lossをautomatic refundにしない。
- pending expiryは参加する全budgetを解放し、liable expiryはfull reservationを保守的に維持。
- classifier failure / invalid units時はclassification error表面化前にfull settlement。
- settlement ACK ambiguityをblind retryせず、Redisではidentical replayをidempotent化。
- Redis lease / tombstone timeはapplication hostではなくRedis serverをauthorityとする。
- admission storage failureをallowへfail openしない。
- observer failureをquota stateから隔離し、error / denyをallowへ変換しない。

### Known limitations

- MCP v2 multi-round `input_required` はv0.1 `protectTool()` で意図的に未対応。Issue #14でsuspend/resume accountingを追跡。
- 1 reservationに参加する全budgetは同じquoted / actual unit countを消費。
- Redis transactional stateは1つのconfigured Redis Cluster hash slotを利用。
- Redis atomicityはfinancial-ledger durabilityを意味せず、persistence / HAはdeployment-specific。
- generic lease renewalはlease loss後のprovider-specific fencingではない。
- observabilityはbest-effort / non-durableで、transactional quota ledgerではない。vendor-specific telemetry adapterはcore packageの責務外。

### Compatibility

- Node.js 20+
- ESM
- `@modelcontextprotocol/server` v2（CIでは現在2.0.0）
- Redis 7 integration behavior
- node-redis `redis` 6.2.x

## Unreleased

未releaseのuser-visible changeは現在ありません。
