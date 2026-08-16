# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

この文書は、v0.2.0後のMCP correctness / Store contract整備を反映した **release-readiness評価** です。v1.0をreleaseする指示ではありません。

この文書によってv1.0 tag、GitHub Release、npm publishを実行することはありません。

## 判定

**現在のsource treeはv1.0 release-candidate準備を継続できる状態で、新たに見つかったIssueもcore transaction model自体の再設計を要求してはいません。ただし、元のreadiness監査後に追加されたIssueにより、v1.0 tag前に解決・検証するかsupport claimを明示的に狭める必要があるfinal-release gateが追加されました。**

現在のpre-v1 gateは #77（Firestore ambiguous-commit semantics）、#78（Firestore cross-instance clock-skew safety）、#79（Node 24 support evidence）、#85（mutable quota-limit semantics）です。#83と#84はv1前の実装を必須としませんが、API freeze時に現行のfixed reservation / same-units multi-budget boundaryをv1 stable contractとして受け入れるか、stable tag前に変更するかを明示的に決める必要があります。

これはoptional integrationがすべて完成したという意味ではありません。stable enforcement boundaryは十分狭く、failure semanticsは明示され、third-party Store compatibilityも実行可能なため、v1 API freeze / finalization processへ進めます。残るgateは既存support claimに対するevidence / contract整備であり、project scopeを広げるためのものではありません。

実際にv1.0 tagを作る直前には [Release時の最終確認](#release時の最終確認) を実施し、上記Issue gateも確認します。

## v1 stable候補の境界

次をv1 stable contract候補とします。

- `UsagePolicy` quoteからatomic `UsageStore.reserve()` へ進むadmission flow
- all-or-nothing multi-budget admission
- `(tenantId, principal.id, tool, operationId)` のreplay identity
- `markLiable()` による明示的 `pending -> cost-liable` transition
- renewable lease
- liability後expiryのconservative behavior
- `actualUnits <= reservedUnits` のterminal settlement
- identical settlement replay / conflicting settlement rejection
- fail-closed storage semantics
- process-local reference implementationとしての `MemoryUsageStore`
- documented deployment constraintとfinal pre-v1 evidence gateを満たしたRedis / Cloudflare Durable Objects / Firestore `UsageStore`
- single-round MCP TypeScript SDK v2 tool向け `protectTool()`
- 現在対応している `input_required` multi-round accounting向け `protectMultiRoundTool()`
- integrity-verified request-state resume、principal / tenant / tool / args binding、one-time compare-and-consume、resume時のsecond reservation禁止
- shared / durable multi-round flow claim向け `RedisMcpUsageFlowStore`
- enforcement outcomeを変更できないprovider-neutral observability
- behavioral compatibility確認用portable `UsageStore` / `McpUsageFlowStore` conformance runner

multi-round stateのv1方針は現行の **shared / durable compare-and-consume** です。fresh MCP requestが別server instanceへ着地してもよく、accountingのためのsticky MCP sessionは不要です。

## Experimental / deferredの境界

次はv1 stable runtime promiseには含めません。

### First-class MCP Tasks protocol adapter

[MCP Tasks の利用量 accounting](mcp-tasks-accounting.ja.md) でadmission、liability、renewal、completion、failure、cancellation、abandonment、worker crash、ambiguous ACK、reconciliationまでaccounting state machineを定義・proof済みです。

一方、upstreamの `io.modelcontextprotocol/tasks` TypeScript integration surfaceは現在experimentalです。そのためupstreamがrelease前にstable化しない限り、v1でstableなfirst-class Tasks wire/runtime adapterは宣言しません。

既存core primitiveだけで安全なtask lifecycleを表現できるため、これはaccounting blockerではありません。business task creation、worker ownership、result replayは `UsageStore` の外に残します。

### 新しいstateless MRTR resume mode

Deferredです。現行shared / durable one-time claimですでにsticky sessionなしのcross-instance resumeを実現しています。client-carried / stateless claimは、one-time claimとambiguous-ACK safetyを維持しつつ具体的な運用上の利点を示せる場合だけ再検討します。

### Progressive reservation growth / heterogeneous multi-dimensional usage

#83と#84はdesign候補であり、v1必須capabilityではありません。current candidate contractでは、metered work開始前にbounded maximumをreserveし、1つのreservationに参加する全budgetへ同じquoted / actual unit countを適用します。

API freeze前に、これらをv1 limitationとして明示的にacceptします。将来progressive top-upやper-dimension / vector accountingを追加する場合は、atomic admission、replay safety、liability / expiry semantics、ACK ambiguity safetyを維持する必要があり、採用するdesignによってpost-v1 additive changeまたはmajor-version contractになる可能性があります。

### Operational snapshot / reconciliation / threshold helper

#76、#81、#82はpost-v1 operational capability候補です。authoritative Store resultやcurrent observer eventと組み合わせることはできますが、second accounting ledgerを作ったりbest-effort telemetryをenforcement authorityにしてはいけません。

### Stable billing / financial-ledger contract

Deferred / out of scopeです。observabilityやoptional downstream billing adapterはenforcement transactionの外側です。このprojectをfinancial-grade ledger、payment processor、billing platformにはしません。

### Generic workflow / result replay

Out of scopeです。usage accounting自身のstateはreconcileできますが、crashやambiguous ACK後に任意のbusiness side effectをblind replayするauthorityは持ちません。

## Production-readiness監査

### Public API / exports / versions

- publish対象5 packageのmanifestはcurrent source-release lineでversion aligned
- ESM / Node.js 20+をcurrent public compatibility floorとして維持
- CIは現在Node.js 20 / 22を実行。#79でopen-endedな `>=20` declaration / Node 24 publish pathとfull Node 24 compatibility evidenceの差を追跡
- public subpath exportをexplicitに列挙し、package tarball内容をallow-list検証
- clean-consumer CIで全local tarballをinstallし、Redis MCP flow / conformance subpathを含むpublic entry pointをimport検証

このreadiness reviewではv1 version bumpを行いません。

### Store invariant整合

built-in Storeは同じpublic lifecycleを守りつつ、providerごとの実装境界を明示しています。

- **Memory** — process-local reference implementation。restart lossを明示的に許容するtest / development / controlled single-process deploymentには利用可能だが、restart-durableまたはhorizontal shared enforcementには使わない
- **Redis** — 1 Lua transaction domain、Redis server time、concurrency / expiry / replay / ACK-loss evidence。persistence / HAはdeployment-specific
- **Cloudflare Durable Objects** — Durable Object + SQLite transaction domain、local workerd test + real deployed dogfood。remote state-changing ambiguityはblind retryせずsurface
- **Firestore** — Firestore transaction + hashed storage identifier。host clock + documented expiry grace / contention limit。#77でambiguous commit / lost-ACK reconciliation semanticsとevidence、#78でcross-instance clock skew下のsupported safety envelopeを追跡

third-party実装は [Store実装contract](store-contract.ja.md) とportable conformance runnerを使います。runner合格だけでbackend durability / failover safetyまで証明したことにはしません。

### Concurrent admission / replay / crash / expiry / partial failure

次のevidenceがあります。

- shared-budget concurrent admission
- multi-budget all-or-nothing
- duplicate logical-operation rejection
- idempotent liability / terminal settlement replay
- conflicting settlement rejection
- pending expiry release
- liable expiry conservative full retention
- lease renewal
- 現時点で実装済みのprovider-specific lost-ACK / retry evidence（Redis / Cloudflareを含む）。Firestoreのexplicit ambiguous-commit reconciliation boundaryは#77で継続追跡
- one-time multi-round resume / mismatch preservation
- lost multi-round consume ACKのfail closed
- ambiguous execution state後にbusiness operationをautomatic replayしない

cancellationは保守的に扱います。cancel request / ACKはcost 0の証明ではなく、pre-cost cancellationを実際に証明できる場合だけ0 settlementを許可します。

### Security boundary

- `Principal` はauthentication / authorizationからderiveするtrusted application inputであり、client credential formatではない
- `operationId` はidempotency inputでありidentity proofではない
- MCP request stateはintegrity verification後、trusted principal / tenant / tool / argsへ再binding
- remote Cloudflareはapplication-defined authorization必須、local以外はHTTPS
- Firestoreはserver-side enforcement infrastructure。untrusted clientへdirect write authorityを渡さない
- raw tool arguments / secretsをdefault telemetryで収集しない
- identifier hashはprivacy minimizationでありencryptionではない

### Horizontal scale

v1 accounting modelは、必要なauthoritative stateをsharedにすれば複数stateless MCP HTTP handlerを利用できます。

```text
HTTP/MCP handlers
    -> shared UsageStore
    -> shared McpUsageFlowStore for multi-round flows
```

Memory Storeは明示的にsingle-process専用です。production horizontal scaleではprovider-backed shared stateを使います。Firestoreについて広いhorizontal shared v1 claimを行う前に、host-clock deployment envelopeが#78のfinal decision / evidenceを満たす必要があります。

### Packaging / clean consumer / Node support

CIでは現在次を確認しています。

- build + unit/integration test
- Node.js 20 / 22
- Redis 7 integration behavior
- package version alignment
- 5 packageすべての `npm pack`
- expected tarball file / source・test artifact漏れなし
- `workspace:` dependency漏れなし
- clean consumerへのinstall / public import

v1前に#79でNode 24を同等のcompatibility evidenceへ追加するか、public runtime claimを実際のtested matrixに合わせて狭めます。

### Release / npm workflow

GitHub source releaseとnpm publicationは意図的に別操作です。

npm publish workflowはmanual-onlyで、次が必要です。

- `workflow_dispatch`
- existing release tag
- explicit `confirm: true`
- package versionとtagの一致
- publish前のtest / pack成功

**npm publicationは引き続きdeferredで、このreadiness workでは絶対に実行しません。**

## Open Issueとblocker分類

### Issue #63 — v1 MCP semantics

**分類: current source treeで解決済み。v1 blockerではありません。**

current-protocol fresh-request proof、shared-state MRTR方針、Tasks accounting design/proof、third-party flow/store contractで意図したacceptance boundaryを満たしました。experimentalなfirst-class Tasks adapterは「対応済み」と誤魔化さずexplicit deferredにします。

### Issue #24 — real Cloudflare operational observation

**分類: post-v1 operational evidence。core v1 blockerではありません。**

real deployed dogfoodではreserve、liability、renewal、settlement、parallel contention、retry、lost ACK、conservative error settlement、fail-closed behavior、transport/privacy reviewまで通っています。残りはdocumented credential rotationを実環境で実行することと、genuine platform-limit / overload / Free-plan exhaustion eventの観測です。

そのため「すべてのCloudflare platform-limit条件でproduction-proven」のような過剰claimは避けますが、provider-neutral v1 API / core accounting semanticsを止める理由にはしません。Issueを閉じるためだけにshared Free-plan quotaを意図的に消費しません。

### Issue #6 — first npm publication

**分類: 意図的にdeferredされたrelease operation。source-readiness blockerではありません。**

明示的なpublish判断があるまでは、npmからinstallできないことをREADME等で明記し続けます。source treeがv1検討可能になっただけで#6をcloseしません。

### Issue #77 / #78 — Firestore failure / time evidence

**分類: Firestore stable-support claimに対するpre-v1 gate。**

#77ではambiguousなFirestore commit / acknowledgement後のsupported behaviorを、second reservationを作らずuncertaintyをunmetered allowへ変換しない形で定義・proofします。#78ではhost-clock skew、expiry grace、lease lifetime、horizontal deploymentのsupported relationshipを定義・検証します。v1前に安全境界を確立できない場合は、暗黙に強い保証を置かずFirestoreのv1 support claimを狭めます。

### Issue #79 — Node 24 compatibility evidence

**分類: pre-v1 release / support-policy gate。**

current package engine declarationはNode 24を許容し、publish pathもNode 24を使用しますが、normal full CI matrixは現在Node 20 / 22です。v1前にNode 24を同じpublic compatibility pathでtestするか、support claimを狭める・明確化します。

### Issue #85 — mutable quota-limit semantics

**分類: pre-v1 policy / Store-contract gate。**

同じ `budget.key` に対してeffective limitを変更する操作は一般的なapplication use caseなので、stable freeze前に1つのexplicit cross-Store contractを定義します。想定方向は、authoritative used / reserved stateを維持し、limit増加後は新limitまでfuture admissionを許可し、limit減少後にcurrent usageがnew limit以上なら新規admissionをdenyすることです。Memory / Redis / Cloudflare / Firestoreでconformance evidenceを持たせます。

### Issue #83 / #84 — future accounting-model extension

**分類: post-v1 implementation候補 + pre-v1 boundary decision。**

progressive reservation growthもheterogeneous per-dimension unitsも、current correctnessを維持するための必須機能ではありません。v1 API freeze前に、stable v1 contractはbounded reservationとparticipating budget全体へのcommon unit countを採用すると明記します。その制約をv1で受け入れられないと判断した場合だけstable tag前に変更します。

### Issue #76 / #81 / #82 — operational capability

**分類: post-v1 optional capability。v1 blockerではありません。**

operational snapshot、per-operation status / reconciliation helper、quota-threshold signalはproduction usabilityを改善できますが、admission / settlementに対してread-only / non-authoritativeのままにします。Storeがsafe resumable stateをproofできない場合、既存fail-closed semanticsを維持します。

## v1前のbreaking-change review

必須のcore redesignは見つかっていません。ただしv1後に変えると高コストなため、final API-freezeで次を再確認します。

1. replay identityは `(tenantId, principal.id, tool, operationId)` のまま
2. 1 reservationに参加する全budgetは同じquoted / actual unit countを使う（#84 boundary）
3. `actualUnits` はreservationを超えず、reservation growthはv1 contractに含めない（#83 boundary）
4. liable expiryでactual usage不明ならfull reservationを保持
5. observer deliveryはbest-effort / non-transactional
6. multi-round business result replayはapplication-owned
7. built-in Storeのtime / durability差を隠してgeneric guaranteeを強くしない
8. 現在のpublic package / subpath名をlong-lived stable APIとして受け入れられるか
9. same-key quota-limit changeは1つのexplicit cross-Store semantic contractに従う（#85）
10. Firestoreのambiguous-commit / clock-skew boundaryが意図したstable support claimに十分明確か（#77 / #78）
11. Node runtime support statementがtested compatibility matrixと一致するか（#79）

breaking contract changeが必要なら **v1 tag前** に行います。

## Release時の最終確認

実際のv1.0 source release直前に、final passを行います。

1. #77、#78、#79、#85を解決・検証するか、対応するstable support claimを明示的に狭める
2. #83 / #84のAPI-freeze decisionを記録し、intentional changeがない限りfixed reservation / same-units multi-budgetをv1 boundaryとしてacceptする
3. exact release commitを選び、`main` がclean / greenであることを確認
4. dedicated release PRで5 packageを同時に `1.0.0` へversion bump
5. intended `Unreleased` entryだけを新しい `1.0.0` changelog sectionへ移し、historical v0.2.0 sectionは書き換えない
6. full supported Node matrix + Redis + Cloudflare local/workerd + Firestore integrationを実行
7. `1.0.0` tarball + clean-consumer verification
8. README / API docsに残るpre-v1表現がrelease後に嘘にならないか確認
9. exact release commitに対してtag-triggered GitHub Release workflowを再監査
10. explicit authorizationがある場合だけv1.0 source tag / GitHub Releaseを作成
11. npm publicationは別のexplicit authorizationがない限り実施しない

## 現在の結論

**Source/API readiness: v1.0 release-candidate / API-freeze準備の継続へGO。**

**Final v1.0 tag / release readiness: #77、#78、#79、#85と#83 / #84のexplicit boundary decision完了までGATED。**

**実際のv1.0 tag / release: 未実施。**

**npm publication: 未実施、引き続きexplicit deferred。**
