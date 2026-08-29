# Roadmap

[English](roadmap.md) | [日本語](roadmap.ja.md)

このRoadmapは、projectのcore categoryである **MCP execution boundaryのfailure-safe transactional usage enforcement** を守るためのものです。

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

generic gateway、billing ledger、governance system、workflow engineへ広げるのではなく、この境界のcorrectness / production usabilityを深めます。戦略上の境界は [Project positioning](positioning.ja.md) を参照してください。

## 現在のbaseline

**v0.10.0がcurrent GitHub/source release baselineです。** publish可能な5 package manifestは `0.10.0` に揃い、Node.js 22+をrequireし、npmにはまだ公開していません。

first npm publicationは#6で追跡するseparate explicit authorization必須の操作です。source-release progressがregistry publicationを意味することはありません。

```text
v0.6 progressive growth [RELEASED]
 -> v0.7 atomic heterogeneous vector [RELEASED]
 -> v0.8 scalar operation reconciliation [RELEASED]
 -> v0.9 repository-wide safety hardening [RELEASED]
 -> v0.10 operational usability [RELEASED]
 -> v0.11 accounting/completion/distribution/API freeze [ACTIVE]
 -> v1.0 feature-free stable promotion
```

## 今後も崩さないsafety boundary

残りの全releaseで次を維持します。

- admission compare + reservationはauthoritative Storeの1 transition
- participating budget / dimensionは全てatomic reserve、またはnone reserve
- pending / cost-liable expiryを分離し、unknown liable usageはconservative
- replay / idempotency identityは1 logical operationへscope
- ambiguous state-changing outcomeをblind retryしない
- scalar / vectorで異種dimensionをsynthetic totalへ変換しない
- MCP multi-round resumeはintegrity-verified / binding-aware / one-time
- observabilityはnon-authoritative
- provider durability / time / HA / lost-ACK制約を明示する
- entitlement、billing、pricing catalog、provider-health policy、financial reconciliationはapplication-owned

## Release済みcapability line

| Release | Decision | Status |
| --- | --- | --- |
| **v0.6.0** | `UsageLease.grow()` / `ProgressiveUsageStore` によるoptional progressive reservation growth | Release済み / Adopted |
| **v0.7.0** | `VectorUsageControl` / `VectorUsageStore` によるoptional atomic heterogeneous vector usage | Release済み / Adopted |
| **v0.8.0** | `OperationReconciliationStore` によるoptional read-only scalar operation reconciliation | Release済み / Adopted |
| **v0.9.0** | repository-wide safety hardening #116〜#127 + Firestore race blocker #143 | Release済み / Complete |
| **v0.10.0** | operational snapshot/runtime identity、canonical settlement diagnostics、scoped threshold/exhaustion helper | Release済み / Adopted |

Firestore outer retryはdefinitive transaction abortだけに限定します。`UNKNOWN` / `UNAVAILABLE` / `INVALID_ARGUMENT` などambiguous/provider failureをgeneric retry allow-listへ昇格しません。

## v0.11でここまで完了したもの

### #166 Redis renewed-lease reliability — complete

renewal failureに見えた現象はtest harness raceでした。parallel Vitest fileが1つのRedis DBを共有し、独立に `FLUSHDB` していたため別testのlive reservationを消していました。Redis runtime renewalはRedis server `TIME`のまま変更せず、Redis test fileをserial化し、lease semanticsを弱めずtiming proofを広げました。

### #105 Node.js support floor — complete

v1 supported runtime floorは **Node.js 22+** です。Node 22 / 24をsupported evidence matrixとします。Node 20はEOLで、compatibility-only protected contextとしてだけ残します。

### #157 Firestore growth-concurrency reliability — complete

Firestore Emulatorはprogressive-growth contention中に `3 INVALID_ARGUMENT: Transaction is invalid or closed.` を返す場合があります。Store runtimeではblanket retryしません。

integration gateへdiagnostic stressを追加し、authoritative stale-cursor rejectionとprovider ambiguityを区別します。same-increment / distinct-incrementの両ambiguity pathを実際に観測し、既存idempotency fenceでexact logical incrementだけをresolveし、one-winner / double-commit invariantを弱めず反復passしています。

### #152 cost-bearing operation lifecycle — existing primitive上でfreeze

provider-backed cost-bearing workのために新しいbilling-specific public primitiveは追加しません。

v1で採用するcompositionは次です。

```text
applicationがtrusted caller + accounting scope + pricingを解決
  -> bounded count/cost exposureをatomic reserve
  -> billable dispatch直前にmark liable
  -> additional billable exposure前にgrow
  -> authoritative work / evidence保持中はrenew
  -> authoritative actual usageでsettle
```

focused proofではshared accounting scopeを複数callerが使うcase、count + provider-cost dimensionのatomicity、maximum exposure、pre-dispatch proven-no-effect release、retry pre-growth、growth deny時のdispatch阻止、post-dispatch ambiguityのconservative retention、settlement bound、duplicate operation protectionをcoverします。

application-owned opaque budget keyでshared accounting bucketを既に表現できるため、coreへ `subscriptionId` / `billingAccountId` / `budgetScopeId` を追加しません。provider costはsafe integer / fixed-scale application unitを使います。defensible maximum exposureもcontrollable pre-growth boundaryも無いproviderでは、このlibraryによるhard spend capをclaimしてはいけません。

詳しくは [Cost-bearing operation](cost-bearing-operations.ja.md)。

### #106 persisted-state compatibility — complete

v1前のdurable provider互換境界をfreezeしました。

- Redisは新規reservation stateへ `schemaVersion: 1` を書き、既存pre-v1 unversioned recordはin-placeで互換読取し、future versionはmutation前にrejectします。
- Firestoreはreservation / budget documentの `schemaVersion: 1` を維持し、unknown versionをrejectします。
- Cloudflare Durable ObjectsはSQLite schema v3までのexplicit migrationを維持し、future schema versionをrejectします。
- provider別のupgrade / rollback safety、backup / restore、fresh accounting-domain reset境界を英日でdocumentしました。

詳しくは [Persisted-state compatibility](persisted-state-compatibility.ja.md)。

### #161 public API/name freeze — complete

不要なStore migrationを増やさず、v1 public vocabularyをfreezeしました。

- direct scalar/vector Store・lease settlement outcomeは意図的にextensibleな `string` を維持します。
- portable canonical classificationは `mcp-usage-control/settlement-outcomes` で提供します。
- built-in MCP adapterはcompatibility aliasをauthoritative settlement前にnormalizeします。
- package名、current public subpath、lifecycle/status/error vocabulary、scalar/vector parity、MCP multi-round naming/scopeをfreezeしました。

詳しくは [v1 public API freeze](v1-public-api-freeze.ja.md)。

### #160 aggregate release-safety enforcement — complete

既存protected context名を維持したまま意味を強化しました。

- `test (20)` はlegacy compatibility required contextで、v1 support evidenceではありません。
- `test (22)` はaggregate release-safety required contextです。
- applicableなNode / Redis / package / tarball / clean-consumer、Cloudflare workerd、Firestore Emulator failureは `test (22)` へ伝播します。
- provider workはpath classifierが非該当と判定した場合だけskipを許可します。
- docs-only変更はlightweight pathを使い、protected contextをdeadlockさせずresolveします。

これによりbranch-protection context renameのadmin操作なしで、release-critical evidenceのaccidental bypassを防ぎます。

## Active v0.11 execution order

残るのはfinal production / evidence trancheだけです。

1. **#24 Cloudflare real-operation boundary** — documented real credential rotationを実行し、honestなv1 platform-limit claimをfinalize。overload/exhaustion eventを作るためだけにshared Free-plan quotaを消費しない
2. **final v0.11 release evidence** — supported Node/package check、Redis、aggregate `test (22)`、Cloudflare workerd、Firestore Emulator、tarball / clean-consumer validation、英日docs、final public-contract reviewを全greenにしunresolved v1 blockerを0にする
3. **#6 first npm publication** — public contract freeze後、separate explicit authorizationがある場合だけ実施し、registry/provenance/clean-installまでverify

## 「v1 complete」の定義

v1.0は未決定事項を最後に解くreleaseではなく、**すでに完成したsurfaceをstableへ昇格するrelease**です。

v1.0前に:

- material capabilityは全てadopt / defer / excludeを明示
- adopted capabilityはfailure semantics、concurrency/provider evidence、packaging coverage、英日docsを完備
- package名、exports、lifecycle semantics、Store support claim、Node support、MCP integration boundaryをfreeze
- cost-bearing workをfrozen accounting lifecycleへmappingし、billing authorityをcoreへ持ち込まない
- persisted-state upgrade / rollback boundaryをdocument / test
- release-critical evidenceをaggregate required release-safety gateで保護
- Cloudflare production claimをobserved evidenceと一致させる
- final source/package/provider evidenceをgreenにする
- v1 blocker分類のIssueを0にする

**v1.0自体では新featureやaccounting modelを追加しません。**

## v1へ向けたIssue分類

| Issue | Target | Direction |
| --- | --- | --- |
| #83 progressive reservation growth | v0.6 | Adopted / released |
| #84 heterogeneous multi-dimensional usage | v0.7 | Adopted / released |
| #81 operation reconciliation/status | v0.8 | Adopted / released |
| #116〜#127 repository safety hardening | v0.9 | Completed / released |
| #143 Firestore vector growth-vs-settle race | v0.9 | Completed release blocker |
| #76 / #99 / #82 operational usability | v0.10 | Completed / released |
| #166 Redis renewed-lease reliability | v0.11 | **Completed** |
| #105 Node.js support floor | v0.11 | **Completed; Node 22+** |
| #157 Firestore progressive growth concurrency | v0.11 | **Completed; diagnostic stress in gate** |
| #152 cost-bearing operation lifecycle | v0.11 | **Existing vector/growth lifecycle上でfreeze** |
| #106 persisted-store compatibility | v0.11 | **Completed; provider compatibility contract frozen** |
| #161 settlement/public lifecycle typing | v0.11 | **Completed; public API/name freeze** |
| #160 required release-safety enforcement | v0.11 | **Completed; aggregate `test (22)` gate** |
| #24 Cloudflare real operational evidence | v0.11 | **Pending final production evidence** |
| #6 first npm publication | separate v0.11/v1 distribution gate | **Open; explicit authorization必須** |

## Release policy

- release mechanicsを楽にするためruntime/accounting semanticsを黙って変更しない
- GitHub/source releaseとnpm publicationはindependent authorization
- provider claimはobserved/test evidenceを超えて強くしない
- GitHub/source release成功はregistry publicationを意味しない
- aggregate required release-safety gateはrelease policyで約束するevidenceと常に一致させる

[Release policy](releasing.ja.md)、[v1.0 readiness review](v1-readiness.ja.md)、[Cost-bearing operation](cost-bearing-operations.ja.md)、各provider docsをproduction deployment前に確認してください。
