# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

主なproject changeを記録します。

## [Unreleased]

現在entryはありません。

## [0.8.0] - 2026-08-22

8回目のGitHub/source release。npm publicationは引き続き別操作で、実施していません。

### Added

- base `UsageStore` のsource compatibilityを維持したまま、optional `OperationReconciliationStore`、`UsageOperationReconciliationInput`、共通 `absent` / `active` / `expired` / `settled` 語彙によるprovider-neutral scalar operation reconciliationを追加。
- retained lifecycle status、expired stateのrepeated read-only観測、expected-state mismatchのfail-closeをcoverするportable `runOperationReconciliationStoreConformance()` / `assertOperationReconciliationStoreConformance()` を追加。
- safe reattachment、retention horizon semantics、明示的indeterminate/fail-close、business-result replayとの境界を定義する英日documentationを追加。

### Provider implementation / proof

- Memory: `reconcileOperation()` はexpiry recoveryを実行せずaccountingを変更せず、retained in-process scalar stateだけをread。process restart後のhistorical absence制約を明示。
- Redis: Redis `TIME` / `HGET` / `ZSCORE`を使うread-only Lua lookup。expected reserved units / budget hashを検証し、malformed settled/tombstone stateを`absent`へ変換せずfail closed。real Redis CIでportable reconciliation conformanceを実行。
- Firestore: deterministic hashed reservation documentをread-only transactionでlookupし、cleanup/recovery writeなしでexpected retained units / budget hashを検証。既存bounded host-clock contractの下でEmulator CIにportable reconciliation conformanceを追加。
- Cloudflare Durable Objects: 既存authenticated read-only reconciliation protocolをcore v0.8 result typeへ統合し、`reconcileRemoteCloudflareOperation()` を追加。`reconcileRemoteCloudflareReserve()` はv0.7互換aliasとして維持し、existing local/deployed lost-ACK proofをcarry forward。

### Safety / compatibility

- reconciliationはcapacity reserve/release、liability、renew、settle、replay state書換えを行わず、status proof専用。
- `absent` はlookup時点でretained stateがないことだけを意味し、Store retention horizon後のhistorical proofやautomatic replay permissionにはしない。
- backend/transport failure、corrupt/unsupported state、scalar/vector mode mismatch、trusted expected-state mismatchを`absent`へ変換せずindeterminate / fail closed。
- mutable budget limitはhistorical operation identityではないため、budget key + expected retained scalar unitsを検証し、既存same-key mutable-limit contractを維持。
- v0.8 generic capabilityは意図的にscalar-only。vector initial-reserve ambiguityは将来equivalentなread-only contractを別途proofしない限りfail closed。
- business side-effect/result replayはapplication-ownedのままusage accountingと分離。
- #81をoptional scalar Store capabilityとしてfuture v1 stable surfaceへ採用。#76/#82/#99を次のv0.9 product decision gateとする。

### Release boundary

- 5 package manifestを`0.8.0`へ揃える。
- normal release gateはNode 20/22/24、real Redis、Cloudflare local workerd、Firestore Emulator、package tarball/content、clean-consumer verification。
- `v0.8.0`は2026-08-22にtag / GitHub source releaseとして公開済み。npm publicationはdeferredのまま別操作。

## [0.7.0] - 2026-08-17

7回目のGitHub/source release。npm publicationは引き続き別操作で、実施していません。

### Added

- 既存scalar `UsageStore` surfaceのsource compatibilityを維持したまま、`VectorUsagePolicy`、`VectorUsageControl`、`VectorUsageLease`、optional `VectorUsageStore`によるatomic heterogeneous usage vectorを追加。
- 異なるunitをsynthetic scalarへ加算せず、dimensionごとのadmission / growth / recovery / settlementを追加。scalar / vector reservationは同じlogical-operation replay domainを共有。
- stable `incrementId`、1つのopaque Store-issued cursor、authoritative quota-denial replay、lost-ACK exact retry、terminal-state fail-closedを備えたreservation-wide vector growth replay fencingを追加。
- atomic partial-denial rollback、concurrency、scalar/vector operation collision、growth replay/conflict、denied growth、pending/liable expiry、settlement bound、grow/settle raceをcoverするportable `runVectorUsageStoreConformance()`を追加。
- vector designとMCP lifecycleの英日documentationを追加。

### Provider implementation / proof

- Memory: atomic reserve/grow/settle、per-dimension recovery、ambiguous-growth retry proofを持つscalar/vector reference implementation。
- Redis: additiveな`mode: "vector"` reservation JSON + vector Lua transaction。既存mode-less recordはscalarのまま。real Redis integrationでvector conformance + committed-growth ACK-loss replayを実行。
- Firestore: schema-v1 reservation documentへadditive optional vector fieldを追加。全dimension/budgetを1 transactionで扱い、automatic transaction retry外でnext cursorを生成。Emulator / fault-injectionでvector conformance + committed-growth ACK lossを検証。
- Cloudflare Durable Objects: schema v3でv1/v2 scalar accounting rowを書き換えず`reservation_vectors`を追加。`transactionSync`でvector accountingを行い、workerd integrationでvector conformance + remote committed-growth ACK-loss replayを検証。

### Safety / compatibility

- 異なるdimensionを1 scalar totalへ変換しない。1 vector reservation内で同じbudget keyを複数dimensionへ所属させない。
- 必要な全dimensionはatomicにcommit、またはnone commit。dimension別の独立reserveをatomic vector相当として扱わない。
- pending expiryは全dimensionをrelease、liable expiryは全dimensionをconservative retain。settlementはdimensionごとのtotal successfully reserved capacity以内に制限。
- vector accountingはoptional capabilityなので既存third-party scalar `UsageStore` implementationは互換。既存Redis / Firestore / Cloudflare scalar dataはbalance/lifecycle rewriteなしでreadable。
- #84をoptional capabilityとしてfuture v1 stable surfaceへ採用。#81をv0.8.0の次decision gateとする。

### Release boundary

- 5 package manifestを`0.7.0`へ揃えた。
- release gateとしてNode 20/22/24、Redis、Cloudflare local workerd、Firestore Emulator、package tarball/content、clean-consumer verificationを実行。
- `v0.7.0`は2026-08-17にtag / GitHub source releaseとして公開済み。npm publicationはdeferredのまま別操作。

## [0.6.0] - 2026-08-17

6回目のGitHub/source release preparation。npm publicationは引き続き別操作で、この変更では許可しません。

### Added

- 既存third-party `UsageStore`へgrowthをmandatory化せず、`UsageLease.grow()` + optional `ProgressiveUsageStore.growReservation()`でfailure-safe progressive reservation growthを追加。
- incrementごとのstable identityとStore-issued opaque growth cursorを追加。lost ACK後のexact retryはcommit済みresultをreplayし、stale cursorでdifferent incrementを送るとfail closed。authoritative quota denialもcapacityを消費せずcursorをrotate。
- sequential / replay / concurrent growth、multi-budget all-or-nothing denial、pending / liable expiry、settlement bound、grow / settle raceをcoverするportable progressive Store conformanceを追加。
- small initial reservation、bounded top-up、deny / ambiguity時のsafe stop、same logical operationを維持するmulti-round / Tasks patternのMCP向け英日exampleを追加。

### Provider implementation / proof

- Memory: detached Store snapshot、exact growth replay、lost-ACK before / after commit、terminal-state fail-closedをreference proof。
- Redis: 1本のLua transactionで全participating budget + reservationをatomic growth。既存reservation JSONへadditive replay metadataを保存し、v0.5 rowはfixed/non-growableのまま。
- Cloudflare Durable Objects: v1 accounting rowを変更せずschema v2で`reservation_growth` tableを追加。`transactionSync`でatomic growthし、local workerdでportable progressive conformance + remote lost-growth-ACK replayを検証。
- Firestore: reservation + 全budget documentを1 transactionで更新。automatic transaction retryで二重growしないようnext growth cursorをcallback外で生成。Emulator progressive conformance + committed-growth ACK-loss fault injectionでprovider境界を検証。

### Safety / compatibility

- `renew()`はlease duration専用のまま。capacity growthは別責務。
- growthはpending / liable stateを維持しTTLをrenewしない。pending expiryはgrown total全量をrelease、liable expiryはgrown total全量をconservative retain。
- `actualUnits`はtotal successfully reserved capacityを超えない。denied incrementはcapacityを増やさない。
- settled / expired/recovered reservationはreplayを含む全growth callをrejectし、stale ACK recoveryでterminal後の追加metered workをauthorizeしない。
- v0.5 provider dataはreadable。growth metadataのないRedis / Firestore record、growth rowのないCloudflare reservationはfixed reservationのまま。
- v0.6判断としてprogressive reservation growthをoptional capabilityとしてfuture v1 stable surfaceへ採用。#84がv0.7.0の次feature decision gate。

### Release boundary

- 5 package manifestを`0.6.0`へ揃える。
- normal release gateはNode 20/22/24、Redis、Cloudflare local workerd、Firestore Emulator、package tarball/content、clean-consumer verification。
- このpreparationでは`v0.6.0` tag、GitHub Release、npm publicationを作成しない。

## [0.5.0] - 2026-08-17

5回目のGitHub/source releaseです。pre-v1 stabilization releaseとして扱い、npm registry publicationは引き続き意図的にdeferredし、このreleaseには含めません。

### Added

- optionalな `mcp-usage-control-cloudflare/auth` subpathと `createCloudflareBearerTokenAuthorizer()` を追加しました。current token 1本とprevious token 1本を一時的に受け付けることで、mandatoryなapplication-defined `authorize(request)` contractを維持したままremote Cloudflare gatewayのcredentialを認証断なしでrotationできます。
- Firestore ambiguous commit / ACK lossについて、reserve、liability、renewal、settlementのretry / replay behaviorを明文化し、post-commit lost-ACK fault-injection coverageを追加しました。
- Firestore cross-instance clock skewについて、boundedなsupport envelopeとpending / liable recoveryのdeterministic multi-instance testを追加しました。
- same-key plan / override changeとapplication-owned policy rollout consistencyを扱うmutable quota-limit guidanceを英日で追加しました。

### Changed / hardened

- same-key mutable quota-limit contractを定義しました。`budget.limit` はreserve attemptごとのeffective admission ceilingで、authoritative reserved / consumed usageはStoreに残ります。limit increase / decreaseで既存accounting stateをreset / revoke / re-price / refundしません。
- portable `UsageStore` conformanceへmutable-limit increase / decreaseとstrict / stale policy viewのconcurrency caseを追加しました。
- Memory / Redis / Cloudflare local workerd / Firestore Emulatorでportable Store conformanceを実行し、Firestoreではshared conformance assumptionに必要なlazy cleanup pathも検証しました。
- Firestoreのv1-candidate support claimを、`expiryGraceMs` をmaximum expected positive clock lead + marginへ合わせるbounded / synchronized host-clock deployment profileとして明確化しました。unknown / unbounded skewはsupport claim外です。
- roadmap / readiness planningを更新し、直近releaseをv0.5.0 stabilizationとし、final v1 scope / API freezeはv0.5後の再評価対象へ戻しました。#83 progressive reservation growth / #84 heterogeneous multi-dimensional usageは確定post-v1ではなくopen v1-scope candidateです。

### Validation / CI

- Node.js 24をNode.js 20 / 22と同じnormal full build / test / Redis / package / clean-consumer matrixへ追加しました。public compatibility floorはNode.js 20+のままです。
- Redis real integration、Cloudflare local workerd、Firestore Emulatorでportable Store conformanceを追加しました。
- local workerdのcredential-rotation coverageと、英日deployed-dogfood runbookへzero-downtime sequence（currentをpreviousへコピー -> currentを置換 -> callerを切替 -> previousをretire）を追加しました。

### Compatibility / release boundary

- backward-compatibleなpre-1.0 minor source releaseで、意図的なbreaking public runtime APIは導入しません。
- Redis / Cloudflare Durable Object / Firestore accounting storage schemaは変更しておらず、v0.5.0向けprovider data migration / resetは不要です。
- core accounting invariantはfail closedを維持します。atomic admission、explicit liability、replay / idempotency safety、conservative ambiguity / expiry handling、mutable effective limit変更時のauthoritative usage preservationは不変です。
- current runtimeはbounded fixed reservation + participating budget全体への1 scalar unit countを維持します。これはv0.5 behaviorとcurrent v1 candidateであり、取り消せないv1 freezeではありません。
- Issue #24はCloudflare実環境の追加operational evidence向けにopenのままで、このsource releaseにはnon-blockingです。
- Issue #6は意図的にdeferredしたままで、packageは引き続きnpm未公開です。
- このsource releaseはv1.0 stableを宣言せず、npm publishせず、experimentalなfirst-class Tasks protocol adapterや#83 / #84 implementationも追加しません。

## [0.4.0] - 2026-08-13

4回目のGitHub/source releaseです。npm registryへの公開は引き続き意図的にdeferredし、このreleaseには含めません。

### Changed

- quota / replay semanticsを弱めず、`MemoryUsageStore` のlong-running single-process運用をhardeningしました。retained operation / tombstoneとnon-zero budget keyをbounded化し、capacity exhaustion時はaccounting stateをevictせず `MemoryUsageStoreCapacityError` でfail closed、`stats()` でretentionを監視、application-ownedな終了済みwindowを `retireBudgetKey()` で明示退役、zero-unit keyを保持せず、store callごとの全reservation scanを避けるdeadline-aware lazy recoveryへ変更しました。
- retention sizing、安全なbudget-window retirement、monitoring、controlled single-process利用とprovider-backed durable/shared Storeの境界を説明するMemory Store運用ガイドを英日で追加しました。

### Compatibility / release boundary

- 後方互換なpre-1.0 minor releaseとしてMemory Store運用APIを追加します。意図的なbreaking public API / configuration changeは含みません。
- Redis / Cloudflare / Firestoreのstorage schemaは変更せず、v0.4.0向けprovider migration / resetは不要です。
- core accounting invariantは不変です。admissionはatomicのまま、authoritative accounting / replay stateをsilent evictionせず、capacity exhaustion時はfail closedします。
- Issue #24はCloudflare実環境の追加operational evidence向けにopenのままで、source release readinessにはnon-blockingです。
- Issue #6は意図的にdeferredしたままで、packageは引き続きnpm未公開です。
- このsource releaseはv1.0 stableを宣言せず、experimentalなTasks protocol adapterやstateless MRTR modeも追加しません。

## [0.3.0] - 2026-08-13

3回目のGitHub/source releaseです。npm registryへの公開は引き続き意図的にdeferredし、このreleaseには含めません。

### Added

- long-running MCP Tasksのaccounting contractを定義・proof test化し、logical operationごとにreservation 1回、liability、lease renewal、completion / failure / cancellation、abandonment、worker crash、ambiguous ACK、reconciliationまで明示しました。upstream integration surfaceがexperimentalな間、stableなfirst-class Tasks wire/runtime adapterはdeferredのままです。
- third-party `UsageStore` / `McpUsageFlowStore` 向けnormative safety contractと、再利用可能な `mcp-usage-control/conformance` / `mcp-usage-control-mcp/conformance` public runnerを追加しました。CIでconformance subpathのtarball / clean-consumer importを検証し、backend durability / failover / ACK evidenceはprovider固有のevidenceとして分離します。

### Changed

- MCP `2026-07-28` / SDK `2.0.0` に対するexplicit conformance proofを追加し、fresh-request multi-round retryとcross-handler resumeを検証しました。v1のMRTR方針はsticky MCP sessionを要求しない現行shared / durable compare-and-consumeとし、新しいstateless MRTR claim modeはdeferredのままです。
- v1-readiness auditを完了し、README / API / roadmap guidanceをsource-release boundaryへ同期しました。v1前に再設計または新runtime機能を必須とする既知のdesign / implementation blockerはありません。
- failure-safeなtransactional usage-enforcement境界とpost-v0.2 MCP-native correctness workが明確になるよう、project positioning / roadmap guidanceを整理しました。

### Release boundary

- Issue #24はCloudflare実環境の追加operational evidence向けにopenのままで、source release readinessにはnon-blockingです。
- Issue #6は意図的にdeferredしたままで、packageは引き続きnpm未公開です。
- このsource releaseはv1.0 stableを宣言せず、experimentalなTasks protocol adapterやstateless MRTR modeも追加しません。

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
- Redis-side Luaでmulti-budget reserve、liability、renewal、settlement、expiry recovery、tombstoneをatomicに処理する `mcp-usage-control-redis`。
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
- 英日user / architecture、Redis、Cloudflare、MCP integration、observability、API、release、security、support、contribution docs。

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
