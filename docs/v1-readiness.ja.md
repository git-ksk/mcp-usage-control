# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

この文書は、将来のv1.0に向けて蓄積したevidenceを記録する **readiness assessment** です。v1 release指示でも、取り消せないAPI-freeze decisionでもありません。

この文書だけでv1.0 tag、GitHub Release、npm publicationを実行しません。

## Status update — v0.7 atomic-vector判断

直近の次source release preparation targetは **v0.7.0** です。`v0.6.0` がlatest released source baselineです。

v0.7 closeout後の実行順序は **v0.8/#81 -> v0.9/#76+#82+#99 -> v0.10 completion -> v1.0 stable promotion** です。#99はGatewayMCPのreal dogfoodから追加されました。consumer側の即時mapping bugはv0.9前に修正可能ですが、再利用可能なMCPUsage contract / diagnosticsはv0.9 decision gateに置きます。

v0.7で#84の判断を明示確定します。

- existing scalar `UsageStore` / `UsageControl` semanticsはsource-compatibleのまま変更しない
- heterogeneous usageは`VectorUsageControl` / `VectorUsageLease` / optional `VectorUsageStore`としてfuture v1へ **採用**
- 異なるunitをsynthetic scalarへ加算しない
- 1 logical operationに必要な全dimension / budgetを1 authoritative Store transaction domainでadmit / grow / recover / settleする
- scalar / vector reservationは同じoperation-idempotency domainを共有
- vector全体で1 Store-issued growth cursorを使い、v0.6 stable increment / lost-ACK semanticsをcompose
- pending expiryは全dimensionをrelease、liable expiryは全dimensionをconservative retain、terminal vectorはgrowth replayをreject
- portable vector conformanceに加え、Redis / Cloudflare Durable Objects / Firestoreでcommitted vector growth ACK-loss fault injectionを持つ

## 判定

**v0.7.0 source-release preparationへGO。normal CI / package / provider integration gate通過が条件です。**

#84はprovider-neutral contractとbuilt-in Store proofを持ち、v0.5 / v0.6までのresolved correctness gateもcarry forwardします。

**v1.0 readinessは引き続きprovisionalです。** #83 progressive growthと#84 atomic heterogeneous vector accountingをoptional future-v1 capabilityとして採用しました。#81 operation reconciliation/statusがv0.8.0の次feature decision gateです。

## v0.7 accounting boundary

application pathは互換な2系統になります。

- **scalar path** — `UsagePolicy` -> `UsageControl` -> `UsageStore`。optional `ProgressiveUsageStore` growthあり
- **vector path** — `VectorUsagePolicy` -> `VectorUsageControl` -> optional `VectorUsageStore`

共通stable invariant:

- 1 logical operationは1 replay identity `(tenantId, principal.id, tool, operationId)`を維持
- admissionに必要な全budget / dimensionはatomic commit、またはnone commit
- metered work前にexplicit liability
- renewはlease durationだけを変更
- ambiguous state-changing resultはfail closedしexact replay / reconciliationを要求
- pending expiryはcapacity release可、liable unknown usageはconservative
- settlementは成功済みreserved capacity以内
- business result replayはapplication-owned

vector固有invariant:

- dimensionごとにunitsとbudget topologyを保持
- 1 vector内で同じbudget keyを複数dimensionへ所属させない
- settlementは全dimensionをexactly once報告し、unused unitはそのdimensionのbudgetだけからrelease
- vector growthはstable `incrementId` 1個 + reservation-wide opaque cursor 1個 + complete topology
- dimension別independent reserveをatomic vector相当として扱わない

## v1 scope decision

### #83 — progressive reservation growth — v0.6で採用

progressive scalar growthはoptional Store extensionとして維持します。atomic all-budget growth、deterministic increment replay identity、lost-ACK fence、pending/liable inheritance、conservative expiry/recovery、terminal-state reject、successfully reserved capacity以内のsettlementをproof済みです。

詳細は[Progressive reservation growth](progressive-reservation-growth.ja.md)と[Progressive MCP growth](progressive-mcp-integration.ja.md)を参照。

### #84 — heterogeneous multi-dimensional usage — v0.7で採用

v0.7ではscalar contractを変更せずoptional vector surfaceを採用します。all-or-nothing dimension admission、one logical replay identity、dimension内hierarchical budget、per-dimension atomic settlement、progressive vector growth/replay、pending/liable recovery、scalar/vector operation collision、provider-neutral Store conformanceをproofします。

Memoryがreference implementation。Redisは1 Lua transaction + additive vector JSON metadata、Firestoreは1 retried transaction + additive optional reservation field、Cloudflare Durable ObjectsはSQLite `transactionSync` + schema-v3 `reservation_vectors` sidecar metadataを使います。existing scalar provider dataはmigration / rewriteなしで読めます。

詳細は[Atomic heterogeneous usage vector](vector-usage.ja.md)と[Vector MCP integration](vector-mcp-integration.ja.md)を参照。

### その他open capability

#81が次v0.8 decision targetです。#76 / #82 / #99はv0.9 operational-usability decisionです。#99ではcanonical settlement-outcome integration vocabulary、invalid integration inputとservice unavailableを区別できるbounded diagnostics、privacy-safe lifecycle visibilityを扱います。second accounting authorityを作らずfail-closedを弱めないlow-risk / clearly usefulなものだけv1候補にします。

first-class MCP Tasks integrationはupstream TypeScript protocol surface依存のままです。accounting lifecycle自体はすでにdefined / proof-testedです。

## Production-readiness evidence

### Public API / packaging / Node

- publish対象5 package manifestをsource releaseごとにversion aligned
- ESM / Node.js 20+をpublic compatibility floorとして維持
- normal CIはNode.js 20 / 22 / 24で同じbuild / test / package / clean-consumer pathを実行
- public subpath exportを列挙し、package tarball内容をallow-list検証
- clean-consumer CIでlocal tarballをinstallしpublic entry pointをimport検証

### Store invariant alignment

- **Memory** — process-local reference implementation。retained stateをbounded化し、capacity exhaustionはfail closed
- **Redis** — 1 Lua transaction domain、Redis server time、concurrency / expiry / replay / ACK-loss evidence
- **Cloudflare Durable Objects** — Durable Object + SQLite transaction domain、local workerd conformance、deployed dogfood、explicit remote ambiguity handling、optional two-token credential rotation
- **Firestore** — transaction + hashed identifier、explicit ambiguous-ACK behavior、bounded / synchronized host-clock deployment contract、deterministic skew evidence

portable Store conformanceはMemory / Redis / Cloudflare local workerd / Firestore Emulatorに対してcommon mutable-limit / lifecycle contractを実行します。runner合格だけでbackend durability / HA / failoverまで証明したことにはなりません。

### Failure semantics evidence

次をcoverしています。

- concurrent shared-budget admission
- multi-budget all-or-nothing
- duplicate logical-operation rejection
- idempotent liability / terminal settlement replay
- conflicting settlement rejection
- pending expiry release / liable expiry conservative retention
- lease renewal
- provider-specific lost-ACK / retry evidence
- Firestore multi-instance bounded-skew recovery
- same-key mutable limit increase / decreaseでauthoritative usageをresetしない
- one-time multi-round resume、mismatch preservation、ambiguous consumeのfail closed
- usage-accounting recoveryとbusiness-operation blind replayの分離

cancellationは保守的です。cancel request / ACKだけではmetered cost 0を証明しません。

## Mutable policy boundary

同じ `budget.key` では、`budget.limit` はそのcallでsuppliedされたeffective admission ceilingで、authoritative used / reserved stateはStoreに残ります。

- increaseはexisting usageを維持してnew headroomだけ開く
- decreaseはusage / reservationを維持し、lower limit以上ならnew workをdeny
- active reservationをpolicy changeでre-price / revokeしない
- settled usageをlowering limitでrefundしない
- key変更は本当に別application-owned accounting bucket / windowの場合だけ
- Store atomicityはapplication instance間のdistributed policy-version consensusを提供しない

詳しくは [Mutable quota limits](mutable-quota-limits.ja.md)。

## Security / horizontal-scale boundary

- `Principal` はauthentication / authorization由来のtrusted application input
- `operationId` はidempotency inputでidentity proofではない
- MCP request stateはintegrity verification後trusted identity / tool / args contextへrebind
- remote Cloudflareはlocal test以外application-defined authorization + HTTPS必須
- Firestoreはserver-side enforcement infrastructure
- raw tool arguments / secretsをdefault enforcement telemetryで収集しない
- production horizontal scaleでは必要なaccounting / flow stateをprovider-backed shared stateへ置く
- Firestore lease-recovery support profileはbounded / synchronized host clockと適切な `expiryGraceMs` を要求

## v0.7 release checks

v0.7.0 source tag / release作成前に:

1. 5 packageをまとめて`0.7.0`へversion alignment
2. Node 20 / 22 / 24 normal CI
3. Redis scalar/progressive/vector conformance + lost-ACK integration、Cloudflare local workerd scalar/progressive/vector conformance + remote lost-vector-growth-ACK integration、Firestore Emulator scalar/progressive/vector conformance
4. package tarball/content/version + clean-consumer verification（public vector conformance export含む）
5. 英日vector / state-machine / MCP / provider-migration docs確認
6. required check green後にimplementation PR merge
7. v0.7.0 tag / GitHub Releaseは別途explicit authorizationがある場合のみ
8. npm publicationは独立authorizationがない限り実行しない

## 将来v1のrelease gate

将来v1.0をreleaseするのは次を満たした後です。

1. pre-v1 v0.x ladderで十分なoperational confidenceを得る
2. #83を含む各deliberate v1-scope candidateを指定gateで明示accept / defer
3. long-lived public package / subpath / API nameを最終review
4. 必要と判断したbreaking contract changeをv1 tag前に実施
5. `1.0.0` でfull package / integration matrix green
6. explicit v1 source-release authorization

v0.6の直後に必ずv1へ進む必要も、future capabilityを全部v1前に完成させる必要もありません。stable boundaryは実需要とsafety evidenceに合わせます。

## Release / npm separation

GitHub source releaseとnpm publicationは別操作です。v0.6.0や将来v1.0のsource releaseがreadyでも、それだけでnpm publishしません。

## 現在の結論

**次source release preparation target: v0.7.0。**

**v0.7.0 readiness: normal CI / provider / package check条件でrelease preparationへGO。**

**#83: optional progressive reservation growthとしてfuture v1へ採用。**

**#84: optional atomic heterogeneous vector usageとしてfuture v1へ採用。**

**#81: v0.8.0の次feature decision target。**

**v1.0は新featureなしのlater stable promotion。**

**npm publicationは引き続きdeferred / separate。**
