# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

主なproject changeを記録します。

## Unreleased

未releaseの変更はまだありません。

## [0.2.0] - 2026-08-12

2回目のGitHub/source releaseです。npm registryへの公開は引き続き意図的に分離し、このrelease準備では実施しません。

### Added

- `protectMultiRoundTool()` による安全なMCP v2 multi-round `input_required` accounting。trusted server-side suspend/resume state、integrity-protected wire `requestState`、principal / tenant / tool / arguments binding、one-time resume consume、明示的suspend TTL、bounded roundsを含みます。
- 2回目のquota reserveを行わずtrusted server-side leaseへ再接続する `UsageLease.toResumeState()` / `UsageControl.resumeLease()`。
- horizontally scaled MCP multi-round server向けshared Redis flow store `RedisMcpUsageFlowStore`。binding-aware atomic consumeとRedis server-time expiryを使用します。
- transactional multi-budget admission、replay protection、保守的expiry recovery、hashed storage identifier、adapter-local recovery observabilityを持つstandalone server-side Firestore `UsageStore`、`mcp-usage-control-firestore`。
- successful admissionの `remainingByBudget` 伝播と、identity / tool・budget key / settlement outcome / raw application reasonをdefaultで除外するlow-cardinality `projectUsageEvent()` structured-log projection。
- Cloudflare remote call全体を対象にしたbounded timeoutと、response bodyを公開しないtransport errorのHTTP status metadata。
- multi-budget atomicity、shared-budget concurrency、pending / liable expiry semantics、idempotent settlement、server-client TypeScript compatibilityを検証する実Firestore Emulator integration。

### Packaging / CI / docs

- publish可能な5 packageをすべて `0.2.0` に統一。
- Redis `mcp-usage-control-redis/mcp-flow` をexplicit public exportへ追加し、npm tarball allow-listへ収録。clean-consumer CIでも直接importします。
- Node.js 20 / 22 CIで5 packageのversion整合を検証し、tarball名をrelease番号のhard-codeではなくpackage versionから導出。
- Firestore integrationとCloudflare integrationのtriggerを分離し、required CI checkはdocs-only軽量pathを維持。不明なchange scopeではfull CIへ保守的にfallback。
- 英日architecture、MCP multi-round、Redis flow store、Firestore、observability、source / tarball、API、release、security、contributor docsをv0.2 behaviorへ同期。

### Security / accounting invariants

- 適用される全budgetのquota reservationは引き続きatomicで、新adapter / MCP multi-roundによって `check -> execute -> record` raceを導入しません。
- server-side MCP resume stateをclient credentialとして扱わず、wire stateはintegrity-protected opaque referenceのみ。resumeはprincipal、optional tenant、tool、argumentsへbindingします。
- matching MCP resume tokenはexactly once consume。mismatchは正当なflowをconsumeせず、ambiguous / lost consume ACKはapplication workへ再入場せずfail closed。
- multi-round workはhandler実行前にcost-liable化。claim後にprocess lossした場合はfull reserved chargeで保守的にexpiryします。
- Firestore reserve / settle / recoveryはtransaction内で処理。expired pendingはcapacityを解放し、expired liableは保守的chargeを維持。
- Firestore document IDはoperation / budget identity materialをhash化して保存。adapterはserver-side専用で、clientへenforcement stateの直接write authorityを与えません。
- observabilityは引き続きbest-effortかつenforcementから隔離。structured projectionはdefaultでlow-cardinality / secret-conscious。
- Cloudflare remote failureはfail closed、reserve reconciliationはread-onlyのまま、response bodyはtransport errorへ伝播しません。

### Compatibility / known limitations

- Node.js 20+。CIはNode.js 20 / 22を実行。
- ESM。
- `@modelcontextprotocol/server` / client v2。CIは2.0.0とofficial `Client + createMcpHandler` protocol pathを実行。
- Redis 7 integration behavior、node-redis `redis` 6.2.x。
- Cloudflare Workers / SQLite Durable Objects、local workerd integration。
- FirestoreはFirebase Local Emulator Suiteと `@google-cloud/firestore` 8.7.0 type compatibilityで検証。
- Firestore lease timestampはhost clock + configurable expiry graceを使い、強く共有されるbudget documentではhotspotが起こり得ます。deployment guidanceに制約を明記。
- Redis flow stateはflowごとのCluster hash slot内でatomicですが、Redis persistence / HAはdeployment-specific。
- `protectTool()` はsingle-roundのまま。`input_required` はopt-in `protectMultiRoundTool()` を使用。
- npm publishは別のmanual operationで、このrelease PRでは実施しません。

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
