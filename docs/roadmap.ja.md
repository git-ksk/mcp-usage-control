# Roadmap

[English](roadmap.md) | [日本語](roadmap.ja.md)

このRoadmapは、projectのcore categoryである **MCP execution boundaryのfailure-safe transactional usage enforcement** を守るためのものです。

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

generic gateway、billing ledger、governance system、workflow engineへ広げるのではなく、この境界のcorrectness / production usabilityを深めます。戦略上の境界は [Project positioning](positioning.ja.md) と継続更新する [競合capability map](competitive-capabilities.ja.md) を参照してください。

## 現在のbaseline

**v1.1.1が現在のstable GitHub/source / npm baselineです。** Node.js 22+対応の5パッケージを2026-10-09に、GitHub Releaseとnpm Trusted Publishingを別途承認して公開しました。registry provenance、GitHub assetとのSHA-256 byte identity、クリーンなNode 22利用側テストを確認済みです。

初回publication gate #6は完了・close済みです。v1.1.0もseparate authorizationされたmanual Trusted Publishing pathを使い、registry provenanceとGitHub Release assetとのbyte identityを独立verifyしました。今後のregistry publicationも引き続き独立authorize対象です。

```text
v0.6 progressive growth [RELEASED]
 -> v0.7 atomic heterogeneous vector [RELEASED]
 -> v0.8 scalar operation reconciliation [RELEASED]
 -> v0.9 repository-wide safety hardening [RELEASED]
 -> v0.10 operational usability [RELEASED]
 -> v0.11 accounting/completion/API/release-safety freeze [RELEASED]
 -> v0.12 product/operations hardening [RELEASED]
 -> v0.13 v1-blocker closure [RELEASED]
 -> v1.0 feature-free stable promotion [RELEASED]
 -> v1.1 post-v1 integration ergonomics [RELEASED]
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
| **v0.11.0** | pre-v1 accounting/runtime/storage/API freeze、aggregate release-safety gate、real Cloudflare rotation evidence | Release済み / Complete |
| **v0.12.0** | product/operations hardening: release provenance/artifact、supply-chain maintenance、incident runbook、競合判断、quota-window projection、provider benchmark | Release済み / Complete |
| **v0.13.0** | final v1-blocker closure: authoritative clock、renew uncertainty、安全なhistorical cleanup、vector reconciliation、bounded input、shipped docs、Node/peer CI | Release済み / Complete |
| **v1.1.0** | additive post-v1 integration ergonomics: bounded Cloudflare exact post-reserve retry (#232)、weak transport-ID dedupを追加しないsingle-round read operation-identity guidance (#233)、release / backoff / test-tool hardening (#237)、privacy-safe exact-retry operational telemetry (#239) | Release済み / Complete |
| **v1.1.1** | 依存関係のセキュリティ修正、Cloudflareテスト領域分離、後方互換の配布・リリース検証（#246、#248） | GitHub + npm公開済み / Complete |

Firestore outer retryはdefinitive transaction abortだけに限定します。`UNKNOWN` / `UNAVAILABLE` / `INVALID_ARGUMENT` などambiguous/provider failureをgeneric retry allow-listへ昇格しません。

## v0.11でここまで完了したもの

### #166 Redis renewed-lease reliability — complete

renewal failureに見えた現象はtest harness raceでした。parallel Vitest fileが1つのRedis DBを共有し、独立に `FLUSHDB` していたため別testのlive reservationを消していました。Redis runtime renewalはRedis server `TIME`のまま変更せず、Redis test fileをserial化し、lease semanticsを弱めずtiming proofを広げました。

### #105 Node.js support floor — complete

v1 supported runtime floorは **Node.js 22+** です。Node 22 / 24をsupported evidence matrixとします。Node 20はEOLでprotected contextには含めません。

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

- Node 20はrequired CIから退役済みです。`test (22)` がprotected aggregate gateで、Node 22 / 24がsupported runtime evidenceです。
- `test (22)` はaggregate release-safety required contextです。
- applicableなNode / Redis / package / tarball / clean-consumer、Cloudflare workerd、Firestore Emulator failureは `test (22)` へ伝播します。
- provider workはpath classifierが非該当と判定した場合だけskipを許可します。
- docs-only変更はlightweight pathを使い、protected contextをdeadlockさせずresolveします。

これによりbranch-protection context renameのadmin操作なしで、release-critical evidenceのaccidental bypassを防ぎます。

### #24 Cloudflare real operational evidence — complete

real production dogfood deploymentでdocument済みzero-downtime credential rotationを完了しました。overlap windowではnew / old credentialを両方acceptし、Cloud Run callerを新Secret Manager versionへ切替、新revision上のreal `list_boards` callが成功し、retire後はrotated-out credentialをrejectしました。既存Durable Object / accounting identityは維持し、Firestore fallbackも有効化していません。

genuine Workers Free-plan exhaustion / platform overloadは自然発生していません。shared quotaを意図的に消費して再現せず、v1 Cloudflare claimは実際にobservedしたdeployed behavior + 既存local/workerd synthetic 429/503 fail-closed evidenceの範囲へ限定します。

## 現在の実行順序

boundedな **v0.12 product/operations hardening** tranche (#177〜#184) と **v0.13 final blocker-closure** tranche (#191〜#198) は、frozen accounting lifecycle / persisted Store contractを再定義せず完了しました。v0.13.0でstable promotionに必要なfinal correctness / operations / distribution / runtime / peer-compatibility evidenceが揃っています。

**v1.1.0はrelease済みのpost-v1 integration-ergonomics source / npm lineです。** #232でopt-in Cloudflare exact post-reserve retry、#233でweak dedupを追加しないMCP operation-identity方針、#237でrelease / backoff / tooling hardening、#239でprivacy-safeなretry運用telemetryを追加しました。すべてadditiveで、frozen v1 accounting / replay boundaryを維持します。separate authorizationされたv1.1.0 Trusted Publishing workflowは成功し、registry tarballもGitHub Release assetとbyte-identicalであることをverify済みです。

## v1.1.1完了・v1.2.0提案中

v1.1.1の保守計画は、source / npmを別途承認した上で**公開完了**しました（#246、#248）。v1.2.0のDeveloper Experience改善は、公開承認も確定日程もない提案段階です。v1の公開API、Store永続化契約、課金・リプレイの意味は維持します。

### v1.1.1 — 保守・セキュリティパッチ（2026-10-09公開済み）

**目的:** 公開APIや利用量会計の振る舞いを意図的に変更せず、依存関係のセキュリティと互換性の検証を正常化します。

- 2026-10-05のsecurity-maintenance実行で報告されたHigh深刻度の推移的依存問題（Firestore系の`brace-expansion`、`@grpc/grpc-js`を含む）を調査します。実際の到達可能性を評価し、最小限の依存関係・lockfile修正を優先します。例外が必要な場合はaudit全体を無効化せず、根拠を残します。
- Dependabot PR #244は**互換性の境界ごとに**審査します。TypeScript、Vitest、Node型定義、Firestoreなどのメジャー更新を8件一括で自動マージせず、パッチとして安全でなければ分割・修正・延期します。Node.js 22/24のサポートと既存MCP SDK最小peer互換を維持し、変更が必要な場合は別途互換性判断を行います。
- 未マージのGitHub Actions更新PR 4件（#186、#189、#230、#231）は、固定SHA・供給元・permissions・runner/runtime要件・protected checkへの影響を個別に検証し、安全なものだけ取り込みます。
- 予約→課金責任→精算、論理操作ID、unknown-liability時の保守的な復旧、読み取り専用reconciliation、provider固有の制限、Storeのスキーマ互換性を変更しません。

**パッチリリースを提案する前の完了条件:**

1. 最新の依存関係監査で、許容根拠のないHigh/Critical指摘が残っていないこと。例外はadvisory、依存経路、露出評価、担当、再確認方針を記録します。
2. 対象commitで`pnpm install --frozen-lockfile`、build、unit/regression test、Node 22/24、およびMCP/Redisの最小・現行peer互換性テストに成功すること。
3. 影響範囲に応じてRedis統合、Firestore Emulatorの競合・障害テスト、Cloudflare workerd/providerテストを実施すること。protected `test (22)`と該当security checkはgreenであり、provider testのskipは既存change classifierにより説明可能であること。
4. 配布tarball、公開entry point、クリーンNode 22 consumer smokeを検証し、patchに非互換API・永続化形式・利用量会計の変更を混入させないこと。
5. 英日ドキュメントを実測結果と一致させること。GitHub/source releaseとnpm Trusted Publishingは**それぞれ別の明示承認**が必要で、このロードマップ更新は公開承認にはなりません。

### v1.2.0候補 — 開発者体験の追加改善（v1.1.1の後）

**目的:** 導入ミスを減らして再利用可能な検証を強化します。第二の会計上の正本を作ったり、既存helperを重複実装したりしません。採用する機能は利用者・統合時の実証された課題からIssue単位で選びます。

**Issue化した実装範囲:** 親Issue [#252](https://github.com/git-ksk/mcp-usage-control/issues/252)。P1は、公式SDKで起動・呼出できるMCPサーバーのサンプル [#253](https://github.com/git-ksk/mcp-usage-control/issues/253)、並行して障害・再照合時の安全な判断手順 [#254](https://github.com/git-ksk/mcp-usage-control/issues/254)、#253を利用する公式SDK経由のE2E [#255](https://github.com/git-ksk/mcp-usage-control/issues/255)。P2は、SDK version記載と配布tarball利用側の互換性検証 [#256](https://github.com/git-ksk/mcp-usage-control/issues/256)。すべて**起票済み・未実装**です。既存のCore/Store/flow conformanceとpeer CIを再利用し、課金・認可の第二の正本やambiguous呼出の自動retryを追加しません。

- **MCP導入導線:** trusted principal / operation ID、quote・reserve・liability・settlement、拒否・失敗時の処理、Memoryから本番Storeへの切替を扱う実行可能な`protectTool()`例を改善します。既存getting-started、`free-plus-credits`、MCP integration資料を再利用し、競合する新APIは作りません。
- **運用playbook:** 既存の`UsageOperationalMonitor`、read-only reconciliation、threshold/projection helperを使い、providerごとの安全な状態確認、復旧判断、quota-window表示、障害診断を整理します。再現可能な不足が残る場合のみ、**read-onlyかつnon-authoritative**なhelper追加を審査し、observer telemetryを請求残高の正本にしません。
- **適合性・障害注入テスト:** 既存のStore/MCP flow conformance kit、決定的な同時実行・lost-ACK・expiry fixture、provider別の証拠資料を強化します。振る舞いの互換性と、Redis/Firestore/Durable Objectsの個別デプロイ条件下での本番安全性を区別します。
- **統合互換性:** MCP SDKの最小・現行peerとNode 22/24を継続検証します。opt-inで後方互換な追加、docs/test中心を優先し、破壊的変更を要する提案は別途major version判断に分離します。

**マイナーリリースを提案する前の完了条件:**

1. 採用する各改善に、独立したIssue、利用実績や再現手順、対象範囲・対象外、リスクに応じたテストがあること。
2. 既存公開export、operation identity、lease、Store契約、永続化schema、scalar/vectorのall-or-nothing会計を維持すること。新しい公開helperは任意・追加的で、clean-consumer配布テストを伴うこと。
3. portable conformance、provider別の回帰証拠、対応runtime/peer matrix、protected aggregate release gateがgreenであり、英日docsと例が一致すること。
4. 認証、サブスクリプション請求、価格表、汎用gateway/control plane、権威的なdashboard、業務副作用の再実行をcoreへ持ち込まないこと。

**実施順:** v1.1.1の脆弱性修正・検証・個別承認されたGitHub/npm公開は完了しました。未マージのDependabot/Actions PRは引き続き別途互換性を審査します。次は実証に基づくv1.2.0 Issue選定・小規模な後方互換改善で、v1.2.0の公開日程・承認は未確定です。

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
| #24 Cloudflare real operational evidence | v0.11 | **Completed; real rotation/caller/rejection proof、platform-limit未観測boundaryを明示** |
| #177 / #178 release provenance + validated artifact | v0.12 | **Completed; accounting semantics変更なし** |
| #179 dependency/action supply-chain maintenance | v0.12 | **Completed** |
| #180 known-bad release / hotfix runbook | v0.12 | **Completed** |
| #181 current operator-doc baseline cleanup | v0.12 | **Completed** |
| #182 maintained competitive capability decision | v0.12 | **Completed; positioning guardrail** |
| #183 safe quota-window/reset UX projection | v0.12 | **Completed; additive non-authoritative helper** |
| #184 provider benchmark / cost-profile harness | v0.12 | **Completed; non-blocking performance evidence** |
| #191〜#198 final v1 blocker closure | v0.13 | **Completed / Release済み; 新billing modelなし** |
| #6 first npm publication | separate v0.13/v1 distribution gate | **Completed / Closed; v1.0.0 publish・verification完了** |
| #232 Cloudflare bounded exact post-reserve retry | v1.1 | **Completed; initial reserveをretryしないexplicit opt-in Cloudflare helper** |
| #233 MCP read-only operationId ergonomics | v1.1 | **Complete; 新APIなし。fresh-per-dispatchまたはexplicit retry-stable tokenを選択し、weak transport identityでdedupしない** |
| #237 v1.1 release / backoff / test-tool hardening | v1.1 | **Completed; exact-subpath release smoke、equal-jitter retry backoff、patched Vitest + source-only discovery** |
| #239 exact-retry operational telemetry | v1.1 | **Completed; privacy-bounded scheduled / recovered / failed event、best-effort delivery、raw identifier / errorなし** |
| #241 v1.1.0 release / npm verification | v1.1 | **Completed; tagged source release、immutable validated asset、Trusted Publishing、provenance、byte identity、clean Node 22 registry install** |

## Release policy

- release mechanicsを楽にするためruntime/accounting semanticsを黙って変更しない
- GitHub/source releaseとnpm publicationはindependent authorization
- provider claimはobserved/test evidenceを超えて強くしない
- GitHub/source release成功はregistry publicationを意味しない
- aggregate required release-safety gateはrelease policyで約束するevidenceと常に一致させる

[Release policy](releasing.ja.md)、[Provider benchmark harness](provider-benchmarks.ja.md)、[v1.0 readiness review](v1-readiness.ja.md)、[Cost-bearing operation](cost-bearing-operations.ja.md)、各provider docsをproduction deployment前に確認してください。