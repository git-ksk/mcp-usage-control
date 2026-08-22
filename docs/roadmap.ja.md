# Roadmap

このRoadmapは、projectのcore categoryである **MCP execution boundaryのfailure-safe transactional usage enforcement** を守るためのものです。

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

generic gateway、billing ledger、governance system、workflow engineへ広げるのではなく、この境界のcorrectnessとproduction usabilityを深めます。戦略上の境界は [Project positioning](positioning.ja.md) を参照してください。

## 現在のbaseline

**v0.9.0がlatest GitHub/source release baselineです。** 2026-08-22に、repository-wide safety hardening #116〜#127とFirestore release blocker #143をcloseしたtested commit `e2a8f8e5dcf725a2c085faa3170a8e38e91504d2` からreleaseしました。

publish可能な5 package manifestはすべて `0.9.0` に揃っています。**npmにはまだ公開していません。** first registry publicationは#6で追跡する別途explicit authorization必須の操作です。

現在のactive product targetは **v0.10.0 / #76 + #82 + #99 operational usability / dogfood diagnostics**、続いて **v0.11.0 / #24 + #6 + #105 + #106 final production/distribution evidence + API freeze**、最後に新featureを追加しない **v1.0.0 stable promotion** です。

実行順序:

```text
v0.6 progressive growth
 -> v0.7 atomic heterogeneous vector
 -> v0.8 scalar operation reconciliation
 -> v0.9 repository-wide safety hardening [RELEASED]
 -> v0.10 operational usability [ACTIVE]
 -> v0.11 completion/distribution/API freeze
 -> v1.0 stable promotion
```

## 今後も崩さないsafety boundary

残りの全releaseで次を維持します。

- admission compare + reservationはauthoritative Storeの1 transition
- participating budgetは全てatomic reserve、またはnone reserve
- pending / cost-liable expiry semanticsを分離し、unknown usageはconservative
- replay / idempotency identityは1 logical operationへscope
- ambiguous state-changing outcomeをblind retryしない
- scalar / vector accountingで異種dimensionをsynthetic totalへ変換しない
- MCP multi-round resumeはintegrity-verified / binding-aware / one-time
- observabilityはnon-authoritativeでenforcement outcomeを変更できない
- provider durability / time / HA / lost-ACK制約はevidence以上の強いclaimへ勝手に拡張しない

## 完了済みpre-v1 capability decision

| Release | Decision | Status |
| --- | --- | --- |
| **v0.6.0** | `UsageLease.grow()` / `ProgressiveUsageStore` によるoptional progressive reservation growth | Release済み / Adopted |
| **v0.7.0** | `VectorUsageControl` / `VectorUsageStore` によるoptional atomic heterogeneous vector usage | Release済み / Adopted |
| **v0.8.0** | `OperationReconciliationStore` によるoptional read-only scalar operation reconciliation | Release済み / Adopted |
| **v0.9.0** | repository-wide safety hardening #116〜#127 + Firestore race blocker #143 | **Release済み / Complete** |

### v0.9.0 release evidence

v0.9ではpublic accounting modelを変更せず、capability同士の交差部をhardeningしました。retained-budget growth integrity、安全なexpiry/timer arithmetic、mutation前validation、MCP unresolved growth保持、Firestore expired-liable reconciliation、Cloudflare remote/maintenance validation、malformed policy fail-close、vector maintenance quota integrity、Redis recovery overflow、pre-auth reconciliation handling、strict boolean authorization、cross-capability regression matrixを含みます。

#143は `vector-growth-vs-settle-race` のinvariantを弱めず解消しました。Firestore outer retryは definitive transaction abortである `ABORTED` / gRPC 10 と HTTP 409だけをbounded jittered backoffでretryします。`UNKNOWN` / `UNAVAILABLE` / `INVALID_ARGUMENT` などambiguous/provider failureはouter retry allow-listへ追加していません。

release validationはNode 20/22/24 package / clean-consumer CI、Redis、Cloudflare local workerd、Firestore Emulatorを通過しました。`v0.9.0` GitHub/source releaseはsuccessです。npm publicationは完了しておらず、#6でdeferredを維持します。

## Active target: v0.10.0 — operational usability

主対象は **#76、#82、#99** です。

second accounting truthを作らず、applicationが次を区別できるbounded operational visibilityを目標にします。

- retained bookkeeping state
- lifecycle telemetry
- authoritative scoped quota state
- threshold / exhaustion signal
- canonical settlement-outcome vocabularyとintegration drift
- service failureとinvalid integration inputを区別するprivacy-safe diagnostics

要件:

- helper / signalはoptionalかつnon-authoritative
- budget windowを暗黙に推測しない
- PII / high-cardinality identifierをdefault metric labelへ昇格しない
- helper / observer failureがadmission / settlementを変更しない
- vector dimensionの意味を混ぜない
- consumer mapping bugはv0.10を待たず即fix可

完了済み隣接work #108 / #109 / #110はnon-blockingです。MCPUsageがentitlement truth、pricing catalog、billing ledger、subscription lifecycleを所有する方向には広げません。

## v0.11.0 — completion / distribution / compatibility freeze

v0.11はfeature expansionではなくfinal pre-v1 completion lineです。

次をresolveまたは明示scopeします。

- **#24 Cloudflare real-operation boundary:** credential rotationと自然に得られるplatform-limit / overload evidence。proof目的でFree-plan exhaustionを人工的に作らない
- **#6 first npm publication:** separate explicit authorizationがある場合のみ実施し、name/ownership、Trusted Publishingまたはbootstrap credential、registry metadata、provenance、package contents、clean registry installを確認
- **#105 Node support floor:** v1のNode.js support floorを決め、`engines` / CI / docs / consumer evidenceを同期
- **#106 persisted-state compatibility:** Redis / Firestore / Cloudflareのupgrade、migration、rollback、newer-schema fail-close contractを明文化
- **public API/name freeze:** 5 package名、exports/subpath、error/state terminology、lifecycle semantics、compatibility claimのfinal review
- **MCP Tasks / MRTR scope:** stable upstreamと同等safety proofがあるsurfaceだけadopt。なければv1から明示defer
- **full release evidence:** integration、package、source release、およびexplicit authorization後のregistry dogfood

v0.11 close時点でv1 blocker分類の未解決Issueを残しません。

## 「v1 complete」の定義

v1.0は、未決定事項を最後に解くreleaseではなく、**すでに完成したsurfaceをstableへ昇格するrelease**です。

v1.0前に:

- material capabilityは全てadopt / defer / excludeを明示
- adopted capabilityはfailure semantics、concurrency/provider evidence、packaging coverage、英日docsを完備
- public package名、export、lifecycle semantics、Store support claim、Node support、MCP integration boundaryをfreeze
- first npm publicationを別途authorizationの下で実地検証
- persisted-state compatibility / rollback boundaryを文書化
- final production evidenceをgreenにする

**v1.0自体では新featureやaccounting modelを追加しません。**

## v1へ向けたIssue分類

| Issue | Target | Direction |
| --- | --- | --- |
| #83 progressive reservation growth | v0.6 | Adopted / released |
| #84 heterogeneous multi-dimensional usage | v0.7 | Adopted / released |
| #81 operation reconciliation/status | v0.8 | Adopted / released |
| #116〜#127 repository safety hardening | v0.9 | Completed / released |
| #143 Firestore vector growth-vs-settle race | v0.9 | Completed release blocker |
| #76 operational usage snapshot | v0.10 | Active |
| #82 threshold/exhaustion signals | v0.10 | Active |
| #99 settlement outcome normalization / dogfood diagnostics | v0.10 | Active |
| #24 Cloudflare real operational evidence | v0.11 | Final completion evidence |
| #6 first npm publication | v0.11 | **Open; separate explicit authorization必須** |
| #105 Node.js support floor | v0.11 | v1前にfreeze |
| #106 persisted-store compatibility | v0.11 | v1前にfreeze |

## Release policy

- release mechanicsを楽にするためruntime/accounting semanticsを黙って変更しない
- GitHub/source releaseとnpm publicationはindependent authorization
- GitHub/source release成功はregistry publicationを意味しない
- npm publicationを明示deferしている場合、failed/cancelled npm workflowによってsource release自体を未完扱いにしない
- provider claimは実測/test evidenceを超えて強くしない

[Release policy](releasing.ja.md)、[v1.0 readiness review](v1-readiness.ja.md)、各provider docsをproduction deployment前に確認してください。
