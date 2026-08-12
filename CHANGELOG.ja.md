# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

主なproject changeを記録します。

## [0.1.0] - 2026-08-11

最初のGitHub/source releaseです。npm registryへの公開は意図的に分離し、後日別途実施できます。

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
- observer failureをenforcement stateから隔離するbest-effort delivery。
- `@modelcontextprotocol/server` v2 single-round tool向け `mcp-usage-control-mcp` adapter。
- normal success、`{ isError: true }`、thrown error、classifier failure、settlement ambiguityを扱うMCP result classification。
- v0.1 `input_required` support boundary向け `UnsupportedMcpUsageFlowError`。
- Redis-side Luaでmulti-budget reserve、liability、renew、settlement、expiry recovery、tombstoneをatomicに処理する `mcp-usage-control-redis`。
- Redis server timeによるlease / tombstone判定とRedis Cluster compatible single-hash-slot transaction domain。
- SQLite-backed Durable Objects、Worker-local / authenticated remote UsageStore、hashed transport identifier、lazy expiry recovery、fail-close remote behaviorを持つ `mcp-usage-control-cloudflare`。
- Cloudflare SQLite schema versioning、既存v1 schemaのsafe adoption、incompatible schemaのfail-close、migration / rollback guidance。
- ambiguousなremote `reserve()` ACKを追加quotaなしで復元するread-only Cloudflare reserve-ACK reconciliation。
- protected/current budgetやactive reservationを守るbounded historical-budget pruning。
- 通常usage credentialへdelete authorityを自動付与しない独立authenticated maintenance endpoint。
- Cloudflare concurrency、multi-budget atomicity、replay、expiry、renewal、lost ACK、reconciliation、maintenance、authentication、observer isolationをlocal workerdで検証するintegration coverage。
- dedicated Workers Free-plan Worker + Durable Object namespace向けrepeatable deployed-Cloudflare dogfood手順。
- MonokuraのGCP `RemoteCloudflareUsageStore` -> 実Cloudflare Durable Objects経路でreserve / markLiable / renew / settle、parallel contention、retry、lost ACK、conservative settlement、fail-closeを実dogfood。
- Cloudflare Free-plan backend-operation / capacity guidanceとbusiness `quota_exceeded` / platform-store failureの明確な分離。
- 実Redis 7 concurrency / crash / ACK-loss / recovery-observability integration test。
- 公式MCP SDK v2 `Client + createMcpHandler` protocol integration test。
- Node.js 20 / 22のfrozen `pnpm-lock.yaml` CI。
- npm-pack tarball smoke test、clean consumer import、`workspace:` dependency漏れのregression protection。
- 英日user / architecture / Redis / Cloudflare / MCP integration / observability / API / release / security / support / contribution docs。

### Safety behavior

- quota compare + reserveをatomic化し、`check -> execute -> record` raceを作らない。
- execution開始後のprocess lossをautomatic refundにしない。
- pending expiryは参加する全budgetを解放し、liable expiryはfull reservationを保守的に維持。
- classifier failure / invalid units時はclassification error表面化前にfull settlement。
- ambiguous reserve ACKをblind retryせず、Cloudflareではexplicit read-only reconciliationを利用。
- settlement ACK ambiguityはfail-close / conservativeに扱い、対応するidentical replayはidempotent。
- Cloudflare reconciliation / historical pruningは追加quota reservationを作らない。
- historical pruningはapplication window semanticsを推測せず、protected/currentまたはactive reservation参照中のbudgetを削除しない。
- Redis lease / tombstone timeはapplication hostではなくRedis serverをauthorityとする。
- admission storage/platform failureをallowへfail openしない。
- observer failureをquota stateから隔離し、error / denyをallowへ変換しない。

### Known limitations

- MCP v2 multi-round `input_required` はv0.1 `protectTool()` で意図的に未対応。Issue #14でsuspend/resume accountingを追跡。
- 実Cloudflare経路ではshared Workers Free-plan quotaを意図的に枯渇させていない。Issue #24にplatform-limit / overloadの自然観測と実credential rotation確認を残す。
- 1 reservationに参加する全budgetは同じquoted / actual unit countを消費。
- Redis transactional stateは1つのconfigured Redis Cluster hash slotを利用。
- Redis atomicityはfinancial-ledger durabilityを意味せず、persistence / HAはdeployment-specific。
- generic lease renewalはlease loss後のprovider-specific fencingではない。
- observabilityはbest-effort / non-durable / not exactly-onceで、transactional quota ledgerではない。
- npm publishは今回のGitHub/source releaseには含めず、明示承認後の別工程とする。

### Compatibility

- Node.js 20+
- ESM
- `@modelcontextprotocol/server` v2（CIでは現在2.0.0）
- Redis 7 integration behavior
- node-redis `redis` 6.2.x
- Cloudflare Workers / SQLite Durable Objects（local workerd integration + deployed Free-plan dogfood）

## Unreleased

### Added

- transactional multi-budget admission、replay protection、保守的expiry recovery、hashed storage identifier、adapter-local recovery observabilityを持つstandalone server-side Firestore `UsageStore`、`mcp-usage-control-firestore`。
- multi-budget atomicity、shared-budget concurrency、pending / liable expiry semantics、idempotent settlementを検証する実Firestore Emulator integrationと、server-client TypeScript compatibility smoke check。
- Firestore deployment、contention / hotspot、source / tarball利用、API、packageについての英日ドキュメント。

### CI

- Firestore IntegrationはFirestore adapter / core / workflow自身の変更で実行。Firestore-only変更ではCloudflare Integrationを起動しない。
