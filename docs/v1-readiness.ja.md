# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

この文書は、v0.2.0後のMCP correctness / Store contract整備を反映した **release-readiness評価** です。v1.0をreleaseする指示ではありません。

この文書によってv1.0 tag、GitHub Release、npm publishを実行することはありません。

## 判定

**現在のsource treeは、v1.0 release candidate / 最終release reviewへ進める状態です。既知のcorrectness blockerとして、v1前に再設計や新しいruntime機能を必須とするものは残っていません。**

これはoptional integrationがすべて完成したという意味ではありません。stable enforcement boundaryが十分狭く、failure semanticsが明示され、built-in Storeにはprovider-specific evidenceがあり、third-party Store compatibilityも実行可能なcontractになったため、v1 API freezeを検討できるという判断です。

実際にv1.0 tagを作る直前には [Release時の最終確認](#release時の最終確認) を実施します。これはarchitecture未完成ではなくrelease hygieneです。

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
- documented deployment constraintを持つRedis / Cloudflare Durable Objects / Firestore `UsageStore`
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

### Stable billing / financial-ledger contract

Deferred / out of scopeです。observabilityやoptional downstream billing adapterはenforcement transactionの外側です。このprojectをfinancial-grade ledger、payment processor、billing platformにはしません。

### Generic workflow / result replay

Out of scopeです。usage accounting自身のstateはreconcileできますが、crashやambiguous ACK後に任意のbusiness side effectをblind replayするauthorityは持ちません。

## Production-readiness監査

### Public API / exports / versions

- publish対象5 packageのmanifestはcurrent source-release lineでversion aligned
- ESM / Node.js 20+をpublic compatibility floorとして維持
- CIはNode.js 20 / 22を実行
- public subpath exportをexplicitに列挙し、package tarball内容をallow-list検証
- clean-consumer CIで全local tarballをinstallし、Redis MCP flow / conformance subpathを含むpublic entry pointをimport検証

このreadiness reviewではv1 version bumpを行いません。

### Store invariant整合

built-in Storeは同じpublic lifecycleを守りつつ、providerごとの実装境界を明示しています。

- **Memory** — process-local reference implementation。restart lossを明示的に許容するtest / development / controlled single-process deploymentには利用可能だが、restart-durableまたはhorizontal shared enforcementには使わない
- **Redis** — 1 Lua transaction domain、Redis server time、concurrency / expiry / replay / ACK-loss evidence。persistence / HAはdeployment-specific
- **Cloudflare Durable Objects** — Durable Object + SQLite transaction domain、local workerd test + real deployed dogfood。remote state-changing ambiguityはblind retryせずsurface
- **Firestore** — Firestore transaction + hashed storage identifier。host clock + documented expiry grace / contention limit

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
- provider-specific testでのlost reserve / liability / settlement ACK
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

Memory Storeは明示的にsingle-process専用です。production horizontal scaleではprovider-backed shared stateを使います。

### Packaging / clean consumer / Node support

CIで次を確認しています。

- build + unit/integration test
- Node.js 20 / 22
- Redis 7 integration behavior
- package version alignment
- 5 packageすべての `npm pack`
- expected tarball file / source・test artifact漏れなし
- `workspace:` dependency漏れなし
- clean consumerへのinstall / public import

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

## v1前のbreaking-change review

必須のpre-v1 redesignは見つかっていません。ただしv1後に変えると高コストなため、final API-freezeで次を再確認します。

1. replay identityは `(tenantId, principal.id, tool, operationId)` のまま
2. 1 reservationに参加する全budgetは同じquoted / actual unit count
3. `actualUnits` はreservationを超えない
4. liable expiryでactual usage不明ならfull reservationを保持
5. observer deliveryはbest-effort / non-transactional
6. multi-round business result replayはapplication-owned
7. built-in Storeのtime / durability差を隠してgeneric guaranteeを強くしない
8. 現在のpublic package / subpath名をlong-lived stable APIとして受け入れられるか

変更する可能性が高いものがあるなら **v1 tag前** に変更します。現時点のknown correctness evidenceから必須変更はありません。

## Release時の最終確認

実際のv1.0 source release直前に、mechanicalな最終passを行います。

1. exact release commitを選び、`main` がclean / greenであることを確認
2. dedicated release PRで5 packageを同時に `1.0.0` へversion bump
3. intended `Unreleased` entryだけを新しい `1.0.0` changelog sectionへ移し、historical v0.2.0 sectionは書き換えない
4. full Node 20/22 CI + Redis + Cloudflare local/workerd + Firestore integrationを実行
5. `1.0.0` tarball + clean-consumer verification
6. README / API docsに残るpre-v1表現がrelease後に嘘にならないか確認
7. exact release commitに対してtag-triggered GitHub Release workflowを再監査
8. explicit authorizationがある場合だけv1.0 source tag / GitHub Releaseを作成
9. npm publicationは別のexplicit authorizationがない限り実施しない

## 現在の結論

**Source/API readiness: v1.0 release-candidate / final-release準備へGO。**

**実際のv1.0 tag / release: 未実施。**

**npm publication: 未実施、引き続きexplicit deferred。**
