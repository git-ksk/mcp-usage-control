# Roadmap

このRoadmapは、projectのcore categoryである **MCP execution boundaryのfailure-safe transactional usage enforcement** を守るためのものです。

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

generic agent-budget、gateway、billing、governance、workflow productへ広げるのではなく、この境界のcorrectnessとproduction usabilityを深めます。戦略上の境界は [Project positioning](positioning.ja.md) を参照してください。

## 現在のbaseline

**v0.8.0はcurrent pre-v1 source baselineとしてrelease / closeout済み**です。#81はdesign / implementation proof gateを通過し、read-only scalar operation reconciliationをoptional future-v1 Store capabilityとして採用済みです。**現在のactive decision targetはv0.9.0 / #76 + #82 + #99です。** subscription credits導入ergonomicsの#108 + #109 + #110はv0.9隣接のconvenience workで、v1 blockerにはしません。

リポジトリ上の実行順序は明確に直列です。**v0.8.0 closeout済み -> v0.9/#76+#82+#99（active）+ non-blocking #108+#109+#110 credit-policy ergonomics -> v0.10/#24+#6+#105+#106 + final freeze -> v1.0 stable promotion** と進めます。現在のconsumer dogfoodで見つかったbugは、このproduct-level ladderを変えず必要なら先行修正できます。

Firestore ACK-loss / bounded clock-skew contract、Node.js 20 / 22 / 24 full-matrix evidence、same-key mutable quota-limit semantics、Memory / Redis / Cloudflare / Firestore共通portable Store conformance、Cloudflare Bearer token rotation supportを含みます。

base runtimeは既存scalar reservation pathを変更せず維持します。v0.6ではscalar reservationのoptional progressive growth、v0.7ではheterogeneous dimension向けの別optional atomic vector pathを追加します。どちらもthird-party Storeへmandatoryにしません。

## 「v1完成」の定義

v1.0は、未決定のfeatureを最後に詰め込むreleaseではなく、**すでに完成したproduct surfaceをstableへ昇格するrelease** とします。

v1.0前に次を完了します。

- v1 productとして重要なcapabilityは、各v0.x releaseで必ず採用 / deferred / excludedを明示決定する
- 採用するcapabilityはfailure semantics、Store / concurrency evidence、packaging coverage、英日docsまで揃える
- 見送るcapabilityは「未完」ではなくdeliberate non-v1 scopeとして明文化する
- public package name、subpath export、core lifecycle semantics、Store support claim、Node support、MCP integration boundaryをfreezeする
- first npm publicationとregistry install / provenanceをv1前に実地検証する
- final pre-v1 releaseでproduction evidenceとrelease mechanicsを完了する

**v1.0自体では新featureやaccounting modelを追加しません。** final pre-v1 surfaceをgreen evidence確認後にstable versionへ昇格するだけにします。

## Pre-v1 completion ladder

以下の各releaseは **decision gate** です。versionに割り当てたから必ずv1へ入れるわけではありません。安全性 / compatibility proofが成立しなければ、そのv0.xでv1から明示defer / excludeし、未決定のままv1へ持ち越しません。

| Release | 主対象 | preferred outcome | release gate |
| --- | --- | --- | --- |
| **v0.6.0** | #83 progressive reservation growth | **採用**: optional v1 core/Store extension | `UsageLease.grow()` + optional `ProgressiveUsageStore`、growth cursor + stable increment identity、atomic multi-budget / lost-ACK / provider conformance proof |
| **v0.7.0** | #84 heterogeneous multi-dimensional usage | **採用**: optional v1 core/Store extension | separate `VectorUsageControl` / `VectorUsageStore`、one logical replay identity、per-dimension atomic admission / growth / settlement、deterministic retry / conflict、provider conformance |
| **v0.8.0** | #81 operation reconciliation / status | **Adopted**: optional scalar v1 Store capability | 共通read-only status語彙、second reservation禁止、mismatch/unprovable stateはfail closed、Memory/Redis/Firestore + Cloudflare subpath、portable/provider evidence |
| **v0.9.0** | #76 operational snapshot + #82 threshold / exhaustion + #99 dogfood integration diagnostics、隣接#108/#109/#110 subscription-credit ergonomics | bounded non-authoritative observability / diagnosticsを整えつつ、weighted credits / window keyのよくある導入をsubscription/pricing infrastructure化せず簡単にする | second accounting truth禁止、scoped authoritative valueのみ、privacy / cardinality safety、helper failureをenforcementから隔離。#109/#110はdeterministicなpolicy composition helperに限定し、opinionatedになるならdocs-onlyで完了可。#108/#109/#110はv1 blockerにしない |
| **v0.10.0** | final completion / distribution / compatibility freeze | 残るv1 scope decisionを全て閉じ、public distribution / runtime / storage compatibility boundaryを実証する | #24 Cloudflare real-operation boundary、#6 first npm publication、#105 supported Node.js floor、#106 persisted-store upgrade/migration/rollback contract、final public API / name review、Tasks / MRTR scope decision、full integration / package / registry dogfood、v1 blocker 0 |
| **v1.0.0** | stable promotion | 完成済みsurfaceをstable宣言 | 新featureなし。v0.10/#24+#6+#105+#106 completion criteria完了後にversion / changelog / release promotionのみ |

SemVer上 `0.10.0` は通常の有効versionです。`0.9.0` の次が必ず `1.0.0` である必要はありません。

## 各decision target

### v0.6.0 — progressive reservation growth (#83)

**判断: future v1 stable surfaceへ採用。** base `UsageStore`はfixed-reservation互換のまま維持し、growthは強いtransaction contractを証明できるStoreだけがopt-inするoptional extensionとする。

current bounded-reservation modelは正しい一方、streaming / iterative / long-running metered workではadmission時に現実的なsafe maximumを決めづらい場合があります。

v1へ入れるなら次を維持する必要があります。

- participating budget全体のatomic all-or-nothing growth
- concurrent admission correctness
- incrementごとのstable idempotency identity
- lost ACK後もduplicate growthしないsafe retry
- pending / cost-liableの明示
- committed increment後のconservative expiry / recovery
- `actual <= total successfully reserved` settlement
- multi-round / Tasksをまたいでも1 logical operation

これを既存modelを弱めずproofできなければ、v0.6でv1非採用を正式決定します。

### v0.7.0 — heterogeneous multi-dimensional usage (#84)

**判断: future v1 stable surfaceへoptional capabilityとして採用。** scalar APIは変更せず、vector callerだけ`VectorUsageControl` / `VectorUsageStore`へopt-inします。

request count、model token、compute seconds、provider work unitなど異なるdimensionをsynthetic scalarへ変換せず1 logical operationで扱います。admission / growth / recovery / settlementはreservation全体の1 atomic domainを維持します。

proof対象はscalar/vector operation collision、multi-dimension all-or-nothing admission、per-dimension settlement bound、vector全体の1 growth cursor、lost-ACK exact replay、partial growthなしのauthoritative denial、pending/liable expiry、growth/settlement raceです。Memory / Redis / Cloudflare Durable Objects / Firestoreでproofし、既存scalar Store実装のsource compatibilityを維持します。

### v0.8.0 — operation reconciliation / status (#81)

**Decision: future v1 stable surfaceへoptional scalar Store capabilityとして採用。** base `UsageStore` のsource compatibilityは維持します。`OperationReconciliationStore` はretained scalar operation stateをproofできるStore向けread-only `reconcileOperation()` capabilityで、Cloudflareはremote base APIへ強制せずauthenticated reconciliation subpathで同等契約を提供します。

共通語彙は `absent`、`active/pending`、`active/liable`、`expired/pending`、`expired/liable`、`settled` です。backend/transport failure、corrupt / unsupported state、trusted-input mismatchは成功statusに変換せず、callerがindeterminateとしてfail closedします。`absent` は「現在retained stateがない」だけで、retention horizon後のautomatic replay permissionではありません。

reconciliationはstrict read-onlyで、capacity reserve/release、liability、renew、settle、replay state書換えを行いません。Memory / Redis / Firestoreはoptional interfaceを実装し、Cloudflareは `reconcileRemoteCloudflareOperation()` で同じcore result語彙を返します。v0.7の `reconcileRemoteCloudflareReserve()` 名は互換維持します。portable conformanceでlifecycle status、expired stateのrepeated read-only観測、expected-state mismatchを検証し、provider-specific ambiguity / time / durability evidenceは別途維持します。

v0.8 claimは意図的にscalar-onlyです。vector initial-reserve ambiguityは将来別途proof済みmechanismを追加しない限りfail closedのままです。business-result replayはusage accounting外のapplication責務です。

### v0.9.0 — operational usability (#76, #82, #99)

applicationごとに次の区別を再発明しなくてよい程度のoptional operational toolingを整えます。

- retained bookkeeping state
- lifecycle telemetry
- authoritative scoped quota state
- threshold / exhaustion notification
- real consumer dogfoodで判明したintegration driftを防ぐcanonical settlement-outcome vocabulary / normalization guidanceとbounded diagnostics（#99）
- principal、args、credential、request bodyを出さず、service unavailableとinvalid integration inputを区別できるprivacy-safe lifecycle counters

#99で観測したGateway側の即時mapping bug（`invalid_browser_request` -> canonical `invalid_arguments`）はconsumer integration fixなので **v0.9を待たず修正可能** です。v0.9では、同じdriftを他consumerで起こしにくく・診断しやすくするMCPUsage側の再利用可能なcontract / diagnostics / operational visibilityを完成させます。

これはbest-effort / non-authoritativeのままです。second ledgerを作らず、budget-window resetを推測せず、notification deliveryをenforcement correctnessへ入れません。

stateful helperよりdocs / exampleの方が安全で単純なら、それをv1 product requirementの達成形として認めます。

v0.9隣接のproduction ergonomicsとして次も追跡します。

- **#108 subscription-style weighted-credit guide:** `plan allowance -> tool units -> window key -> reserve/settle` を英日で一連に説明し、同一window内plan変更とbilling/historyの責務境界も明示。
- **#109 weighted-credit quote helper:** trustedな `tool -> units` mapping、unknown-toolの明示処理、caller-owned plan/budget resolverを組み合わせる小さなvalidated `UsagePolicy` helperを検討。
- **#110 accounting-window key helper:** scope / window / time zone / clock inputからday/month keyをdeterministicに生成し、consumerの手書きkey rotationを減らす。ただしcalendar/business-window ownershipはapplication側のまま、plan名をkeyへ入れて同一window usageをresetする設計は避ける。

これらは **non-blocking v0.9 ergonomics** です。entitlement truth、Remote Config / Stripe / RevenueCat直接読込、pricing catalog、billing ledger、subscription lifecycleをMCPUsageへ持ち込みません。helperがその境界を越えるならgeneric APIを維持し、#108のcanonical exampleで解決します。

### v0.10.0 — completion release

v0.10はfeature expansionではなくfinal pre-v1 completion lineです。

次を解決します。

- **Cloudflare #24:** real credential rotationを実施。real platform-limit / overload evidenceは自然に観測できればcaptureし、Issueを閉じるためだけにFree-plan quotaを意図的に枯渇させない。未観測ならv1 Cloudflare claimを実観測evidenceに合わせて明示scopeする
- **npm #6:** separate explicit authorizationがある場合だけselected v0.10 tagをfirst npm publishし、provenance、registry metadata、package contents、registry clean installを検証
- **Node support #105:** v1のsupported Node.js floorを明示決定し、`engines` / CI / support claim / clean-consumer evidenceを揃える。EOL runtimeのcompatibility testを暗黙のsupport promiseにしない
- **persisted-state compatibility #106:** Redis / Firestore / Cloudflareのupgrade / migration / newer-schema fail-close / rollback保証を定義し、SemVer/API stabilityとstorage-state compatibility boundaryを混同しない
- **public API / name freeze:** 5 package name、exports / subpath、error / state terminology、lifecycle semantics、compatibility statementを最終確認
- **MCP Tasks:** upstream TypeScript Tasks surfaceが十分stableならfirst-class adapter採用を判定。まだexperimentalならaccounting semanticsは維持しつつv1 stable adapterから明示除外
- **stateless MRTR alternative:** concrete benefit + equivalent one-time / lost-ACK proofがなければshared / durable compare-and-consumeをv1として確定し、alternativeはnon-v1 workへ分類
- Node 20 / 22 / 24、Redis、Cloudflare workerd、Firestore Emulator、tarball、clean consumer、必要なdeployed / manual evidenceをfull確認
- v1 release blockerに分類されたopen issueを0にする

## v1に向けたIssue分類

| Issue | target decision | current direction |
| --- | --- | --- |
| #83 progressive reservation growth | **v0.6.0** | **採用**: optional progressive Store capability + `UsageLease.grow()` |
| #84 heterogeneous multi-dimensional usage | **v0.7.0** | **採用**: optional atomic vector Store capability + `VectorUsageControl` |
| #81 operation reconciliation / status | **v0.8.0** | **Adopted**: optional scalar read-only capability vocabulary + Store support matrix |
| #76 operational usage snapshot | **v0.9.0** | bounded non-authoritative helper / patternを採用優先 |
| #82 threshold / exhaustion signals | **v0.9.0** | #76 semantics上のoptional scoped helper / patternを採用優先 |
| #99 settlement outcome normalization / dogfood diagnostics | **v0.9.0** | canonical integration vocabulary明確化、invalid outcomeとservice outageの診断分離、privacy-safe lifecycle visibility。consumer mapping bugは先行修正可 |
| #108 subscription-style weighted credits guide | **v0.9隣接 / non-blocking** | Free/Plus/月次credits導入と責務境界のcanonical guide |
| #109 weighted-credit quote helper | **v0.9隣接 / non-blocking** | pricing/subscriptionを所有せずconsumer重複コードを減らせる小さなvalidated policy helperなら採用優先 |
| #110 accounting-window key helper | **v0.9隣接 / non-blocking** | day/month keyをexplicit scope/time-zone入力からdeterministic生成し、plan変更でusageを誤resetしない |
| #24 Cloudflare deployed operational evidence | **v0.10.0** | real rotation完了 + honest v1 evidence boundary確定 |
| #6 first npm publication | **v0.10.0** | v1前にfirst registry publish。ただしexplicit authorization必須 |
| #105 supported Node.js floor | **v0.10.0** | v1 runtime floorを決定し、publish前にengines / CI / docsを整合 |
| #106 persisted-store migration/rollback contract | **v0.10.0** | provider upgrade/downgrade/schema compatibility semanticsをv1前にfreeze |
| #77 / #78 / #79 / #85 | 解決済み | 後続全releaseへevidence継承 |

原則は **「maybe v1」をv0.10より後へ残さない** です。proof付きで採用するか、v1 stable product外へ明示分類します。

## pre-v1 featureが弱めてはいけないstable invariant

- admission compare + reservationはauthoritative Storeの1 operation
- 1 logical admissionに必要なbudget / dimensionは全部atomic commit、または全部失敗
- replay identityはstableだがauthenticationではない
- metered execution前にexplicit liability
- pending expiryはrelease可能、liable unknown usageはconservative
- ambiguous state-changing outcomeをblind retryしない
- Store / platform failureをallowへ変えない
- observability / alertをenforcement authorityにしない
- business side effect / result replayはusage accounting外
- provider-specific durability / time / HA limitationをover-strong generic claimで隠さない

## MCP-native scope

multi-roundはshared / durable one-time compare-and-consumeをcurrent directionとして維持し、sticky MCP sessionを要求しません。stateless / client-carried alternativeは同等のreplay / ACK-ambiguity safetyをproofするまで採用しません。

[MCP Tasks の利用量 accounting](mcp-tasks-accounting.ja.md) ではsafe accounting lifecycleを既に定義済みです。first-class Tasks wire/runtime adapterはv0.10でupstream stabilityを見て判断するscope itemであり、current core correctness gapではありません。

## Third-party Store contract

portable conformanceは引き続きbehavioral baselineです。

```ts
import {
  assertUsageStoreConformance,
  runProgressiveUsageStoreConformance,
} from 'mcp-usage-control/conformance';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';
```

v0.6〜v0.9で採用するcapabilityがStore behaviorを変える場合、必要に応じportable contractを拡張します。portable runner合格は必要条件ですが、backend-specific durability、failover、authoritative time、lost-ACK evidenceの代替にはなりません。

## Non-goals

core runtimeはgeneric agent runtime / budget authority、ordinary HTTP rate limiter、payment / subscription system、financial ledger、OAuth provider、billing dashboard / pricing catalog、gateway / router、vendor billing protocol implementation、generic workflow engine、ambiguous state-changing operationをblind retryするsystemにはしません。
