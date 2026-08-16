# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

この文書は、v0.2.0後のMCP correctness / Store contract整備を反映した **release-readiness評価** です。v1.0をreleaseする指示ではありません。

この文書によってv1.0 tag、GitHub Release、npm publishを実行することはありません。

## 判定

**current source treeはv1.0 API-freeze / finalizationを継続できる状態です。元の監査後に追加されたpre-v1 correctness / evidence gateは解決済みで、core transaction modelの再設計は不要でした。**

解決済みgate:

- #77 — Firestore ambiguous commit / ACK loss semantics
- #78 — Firestore bounded cross-instance clock-skew safety
- #79 — Node.js 24 full compatibility-evidence matrix
- #85 — existing accounting bucketに対するmutable quota-limit semantics

残るpre-v1 design workは#83 / #84の明示的なboundary decisionです。progressive reservation growthとheterogeneous multi-dimensional usageはv1前の実装必須ではありませんが、現行fixed-reservation / same-units multi-budget modelをstable v1 boundaryとしてacceptするか、tag前に変更するかを決める必要があります。

optional integrationがすべて完成したという意味ではありません。stable enforcement boundaryは十分狭く、failure semanticsは明示され、built-in Store support claimに必要なevidence / contractが揃い、third-party Store compatibilityもexecutableです。optional operational capabilityはpost-v1候補として残します。

実際にv1.0 tagを作る前には、この文書末尾のrelease-time checkを実行し、明示的なrelease authorizationを得ます。

## v1 stable候補の境界

次をv1 stable contract候補とします。

- `UsagePolicy` quote -> atomic `UsageStore.reserve()`
- all-or-nothing multi-budget admission
- replay identity `(tenantId, principal.id, tool, operationId)`
- `markLiable()` によるexplicit `pending -> cost-liable`
- renewable lease
- liability後expiryのconservative behavior
- `actualUnits <= reservedUnits` のterminal settlement
- identical settlement replay / conflicting settlement rejection
- fail-closed storage semantics
- same-key mutable effective limitでもauthoritative reserved / consumed usageを維持
- process-local reference implementationとしての `MemoryUsageStore`
- documented deployment constraintを持つRedis / Cloudflare Durable Objects / Firestore `UsageStore`
- single-round MCP TypeScript SDK v2 tool向け `protectTool()`
- 現在対応する `input_required` multi-round accounting向け `protectMultiRoundTool()`
- integrity-verified request-state resume、principal / tenant / tool / args binding、one-time compare-and-consume、resume時のsecond reservation禁止
- shared / durable multi-round flow claim向け `RedisMcpUsageFlowStore`
- enforcement outcomeを変更できないprovider-neutral observability
- behavioral compatibility確認用portable `UsageStore` / `McpUsageFlowStore` conformance runner

multi-round stateのv1方針は現行 **shared / durable compare-and-consume** です。fresh MCP requestが別server instanceへ着地してもよく、accountingのためのsticky MCP sessionは不要です。

## Experimental / deferredの境界

### First-class MCP Tasks protocol adapter

[MCP Tasks の利用量 accounting](mcp-tasks-accounting.ja.md) でadmission、liability、renewal、completion、failure、cancellation、abandonment、worker crash、ambiguous ACK、reconciliationまで定義・proof済みです。

ただしupstream `io.modelcontextprotocol/tasks` TypeScript integration surfaceはexperimentalです。upstreamがrelease前にstable化しない限り、v1でstableなfirst-class Tasks wire/runtime adapterは宣言しません。business task creation、worker ownership、result replayは `UsageStore` の外に残します。

### 新しいstateless MRTR resume mode

Deferredです。現行shared / durable one-time claimですでにsticky sessionなしのcross-instance resumeを実現しています。client-carried / stateless claimはone-time claimとambiguous-ACK safetyを維持し、具体的な運用上の利点がある場合だけ再検討します。

### Progressive reservation growth / heterogeneous multi-dimensional usage

#83と#84はdesign候補で、v1必須capabilityではありません。current candidate contractではmetered work前にbounded maximumをreserveし、1 reservationに参加する全budgetへ同じquoted / actual unit countを適用します。

API freeze前にこれをv1 limitationとして明示的にacceptします。将来のprogressive top-up / per-dimension vector accountingはatomic admission、replay safety、liability / expiry、ACK ambiguity safetyを維持する必要があります。

### Operational snapshot / reconciliation / threshold helper

#76、#81、#82はpost-v1 operational capability候補です。authoritative Store resultやobserver eventと組み合わせることはできますが、second accounting ledgerやenforcement authorityにはしません。

### Stable billing / financial-ledger contract

Deferred / out of scopeです。observability / optional downstream billing adapterはenforcement transaction外です。このprojectをfinancial-grade ledger、payment processor、billing platformにはしません。

### Generic workflow / result replay

Out of scopeです。usage accounting stateはreconcileできますが、crash / ambiguous ACK後に任意business side effectをblind replayするauthorityは持ちません。

## Production-readiness監査

### Public API / exports / versions

- publish対象5 package manifestはcurrent source-release lineでversion aligned
- ESM / Node.js 20+をcurrent public compatibility floorとして維持
- normal full CIはNode.js 20 / 22 / 24で同じbuild / test / package / clean-consumer pathを実行
- manual npm publication runtimeのNode 24もnormal compatibility evidence内
- public subpath exportをexplicitに列挙し、package tarball内容をallow-list検証
- clean-consumer CIで全local tarballをinstallし、Redis MCP flow / conformance subpathを含むpublic entry pointをimport検証

このreadiness reviewではv1 version bumpを行いません。

### Store invariant整合

- **Memory** — process-local reference implementation。restart lossを明示的に許容するtest / development / controlled single-process用途向け
- **Redis** — 1 Lua transaction domain、Redis server time、concurrency / expiry / replay / ACK-loss evidence。persistence / HAはdeployment-specific
- **Cloudflare Durable Objects** — Durable Object + SQLite transaction domain。local workerdでportable conformance + real deployed dogfood。remote ambiguityはblind retryせずsurface
- **Firestore** — Firestore transaction + hashed storage identifier。explicit ambiguous-ACK contractとbounded / synchronized host-clock deployment contract、deterministic skew evidenceを持つ。shared-document contentionはdeployment constraint

mutable-limit contractは同じportable `UsageStore` conformance runnerでMemory、Redis、Cloudflare local workerd、Firestore Emulatorに対して実行します。

third-party実装は [Store実装contract](store-contract.ja.md) とportable conformance runnerを使います。runner合格はbehavioral compatibilityを示しますが、backend durability / failover safetyまで証明するものではありません。

### Concurrent admission / replay / crash / expiry / partial failure

次のevidenceがあります。

- shared-budget concurrent admission
- multi-budget all-or-nothing
- same-key limit increase / decreaseでauthoritative usageをresetしない
- stricter / stale-higher effective policy viewのconcurrency
- duplicate logical-operation rejection
- idempotent liability / terminal settlement replay
- conflicting settlement rejection
- pending expiry release
- liable expiry conservative full retention
- lease renewal
- Redis / Cloudflare / Firestoreのdocumented contractに沿ったprovider-specific lost-ACK / retry evidence
- Firestore bounded-skew multi-instance lease / recovery evidence
- one-time multi-round resume / mismatch preservation
- lost multi-round consume ACKのfail closed
- ambiguous execution state後にbusiness operationをautomatic replayしない

cancellationは保守的です。cancel request / ACKはcost 0の証明ではなく、pre-cost cancellationを実際に証明できる場合だけ0 settlementを許可します。

### Mutable policy boundary

同じ `budget.key` では、`budget.limit` はそのcallに対するeffective admission ceilingで、authoritative used / reserved stateはStoreに残ります。

- increase: 既存usageを維持し、新headroomだけ開く
- decrease: 既存usage / reservationを維持し、lower limit以上ならnew workをdeny
- active reservationをpolicy changeでre-price / revokeしない
- settled usageをlower limitによってrefundしない
- key変更は本当に別application-owned accounting bucket / windowの場合だけ
- `MemoryUsageStore.retireBudgetKey()` をplan-change / quota-reset APIとして使わない

`UsageStore` はdistributed policy-version consensusを提供しません。application instanceがold / new effective limitを同時に提示した場合、それぞれのadmissionはcallerが渡したlimitを使います。strict downgrade cutoverにはapplication-level policy rollout consistencyが必要です。詳しくは [Mutable quota limit](mutable-quota-limits.ja.md)。

### Security boundary

- `Principal` はauthentication / authorization由来のtrusted application inputでありclient credential formatではない
- `operationId` はidempotency inputでありidentity proofではない
- MCP request stateはintegrity verification後、trusted principal / tenant / tool / argsへrebind
- remote Cloudflareはapplication-defined authorization必須、local以外はHTTPS
- Firestoreはserver-side enforcement infrastructure。untrusted clientへdirect write authorityを渡さない
- raw tool arguments / secretsをdefault telemetryで収集しない
- identifier hashはprivacy minimizationでありencryptionではない

### Horizontal scale

必要なauthoritative stateをsharedにすれば複数stateless MCP HTTP handlerを利用できます。

```text
HTTP/MCP handlers
    -> shared UsageStore
    -> shared McpUsageFlowStore for multi-round flows
```

Memory Storeはsingle-process専用です。production horizontal scaleではprovider-backed shared stateを使います。

Firestoreのv1 support profileでは、application clockをbounded / synchronizedにし、`expiryGraceMs` をmaximum expected positive pairwise clock lead + measurement margin以上に設定します。unknown / unbounded skewはstable Firestore lease-recovery claimの外です。

### Packaging / clean consumer / Node support

CIは次を検証します。

- build + unit/integration test
- Node.js 20 / 22 / 24
- Redis 7 integration
- Cloudflare local workerd integration
- Firestore Emulator integration
- package version alignment
- 5 packageすべての `npm pack`
- expected tarball file / source・test artifact漏れなし
- `workspace:` dependency漏れなし
- clean consumerへのinstall / public import

### Release / npm workflow

GitHub source releaseとnpm publicationは別操作です。

npm publish workflowはmanual-onlyで、`workflow_dispatch`、existing release tag、explicit `confirm: true`、package version / tag一致、publish前test / pack成功が必要です。

**npm publicationはdeferredで、このreadiness workでは実行しません。**

## Open Issueとblocker分類

### Issue #63 — v1 MCP semantics

**分類: 解決済み。v1 blockerではありません。**

current-protocol fresh-request proof、shared-state MRTR方針、Tasks accounting design/proof、third-party flow/store contractでacceptance boundaryを満たしています。experimental Tasks adapterはexplicit deferredです。

### Issue #24 — real Cloudflare operational observation

**分類: post-v1 operational evidence。core v1 blockerではありません。**

real deployed dogfoodで主要accounting pathは検証済みです。残りはdocumented credential rotationとgenuine platform-limit / overload / Free-plan exhaustion eventの観測です。Issueを閉じるためだけにshared Free-plan quotaを意図的に消費しません。

### Issue #6 — first npm publication

**分類: 意図的にdeferredされたrelease operation。source-readiness blockerではありません。**

明示的publish判断まではnpm未公開をdocsで明記します。

### Issue #77 / #78 — Firestore failure / time evidence

**分類: 解決済みpre-v1 gate。**

#77はambiguous reserveをfail closedにし、liability / renewal / settlementのsafe same-reservation retry / replayをpost-commit ACK-loss fault injectionでproofしました。#78はbounded / synchronized clock support envelopeを定義し、pending / liable recoveryをmulti-instance deterministic testでproofしました。

### Issue #79 — Node 24 compatibility evidence

**分類: 解決済みpre-v1 release / support-policy gate。**

Node 24はNode 20 / 22と同じnormal full CI pathでbuild / test、Redis integration、package verification、`npm pack`、clean-consumer install / importを実行します。minimum runtimeはNode 20+のままです。

### Issue #85 — mutable quota-limit semantics

**分類: 解決済みpre-v1 policy / Store-contract gate。**

same-key contractはincrease / decreaseでもauthoritative reserved / consumed stateを維持し、active reservationを壊さず、lower limit以上ならnew workをdenyし、policy rollout consistencyをapplication-ownedとして明記します。同じportable conformanceをMemory / Redis / Cloudflare / Firestoreで検証します。

### Issue #83 / #84 — future accounting-model extension

**分類: post-v1 implementation候補 + remaining pre-v1 boundary decision。**

progressive reservation growth / heterogeneous per-dimension unitsはcurrent correctnessの必須機能ではありません。v1 API freeze前にstable v1 contractがbounded reservationとparticipating budget全体へのcommon unit countを採用すると明示します。acceptできない場合だけstable tag前に変更します。

### Issue #76 / #81 / #82 — operational capability

**分類: post-v1 optional capability。v1 blockerではありません。**

operational snapshot、per-operation status / reconciliation helper、quota threshold signalはproduction usabilityを改善できますが、admission / settlementに対してread-only / non-authoritativeを維持します。

## Breaking-change review before v1

以下はevidence gateによってstable choiceとして確認済みです。

- replay identityは `(tenantId, principal.id, tool, operationId)`
- liable expiryはactual usage不明ならfull reservation保持
- observer deliveryはbest-effort / non-transactional
- multi-round business result replayはapplication-owned
- Storeごとのtime / durability差を強いgeneric guaranteeで隠さない
- same-key effective-limit changeでauthoritative usageをresetしない
- Firestore stable supportはexplicit ambiguous-ACK / bounded-clock contractを使う
- Node runtime supportはNode 20 / 22 / 24 full CI evidenceで裏付ける

final API-freezeでは次だけを明示確認します。

1. 1 reservationに参加する全budgetへ同じquoted / actual unit countを適用する (#84)
2. `actualUnits` はreservationを超えず、reservation growthはv1 contract外 (#83)
3. current public package / subpath名をlong-lived stable APIとして受け入れる

breaking contract changeが必要なら **v1 tag前** に行います。

## Release時の最終確認

1. #83 / #84 API-freeze decisionを記録し、変更しない限りfixed reservation / same-units multi-budgetをv1 boundaryとしてaccept
2. exact release commitを選び、`main` clean / greenを確認
3. dedicated release PRで5 packageを同時に `1.0.0` へversion bump
4. intended `Unreleased` entryだけを新しい `1.0.0` changelog sectionへ移動
5. full Node 20 / 22 / 24 matrix + Redis + Cloudflare local/workerd + Firestore integrationを実行
6. `1.0.0` tarball + clean-consumer verification
7. README / API docsのpre-v1表現を最終確認
8. exact release commitに対してtag-triggered GitHub Release workflowを再監査
9. explicit authorizationがある場合だけv1.0 source tag / GitHub Releaseを作成
10. npm publicationは別のexplicit authorizationがない限り実施しない

## 現在の結論

**Source/API readiness: v1.0 API-freeze / finalization継続へGO。**

**Pre-v1 correctness / evidence gate #77 / #78 / #79 / #85: 解決済み。**

**Final v1.0 tag / release readiness: #83 / #84の明示boundary decision + 通常release mechanics / authorizationのみがgate。**

**実際のv1.0 tag / release: 未実施。**

**npm publication: 未実施、explicit deferredを維持。**
