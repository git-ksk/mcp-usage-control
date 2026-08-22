# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

この文書は、将来のv1.0に向けて蓄積したevidenceを記録する **readiness assessment** です。v1 release指示でも、取り消せないAPI-freeze decisionでもありません。

この文書だけでv1.0 tag、GitHub Release、npm publicationを実行しません。

## Status update — v0.8 operation reconciliation decision

`v0.8.0` がlatest released GitHub/source baselineでcloseout済みです。**v0.9.0がactive product decision targetです。#116〜#127のaudit safety hardeningを先に閉じ、その後#76 + #82 + #99へ進みます。**

v0.8後の実行順序は **v0.9 safety hardening #116〜#127 -> v0.9/#76+#82+#99 -> v0.10/#24+#6+#105+#106 completion -> v1.0 stable promotion** です。このhardening setはv0.9内の実装順序であり、v0.8.1 releaseを必須にはしません。#99はGatewayMCP real dogfoodから追加され、consumer側の即時mapping bugは先行修正可能ですが、再利用可能なMCPUsage diagnosticsはv0.9 decision gateに置きます。

v0.8で#81の判断を明示確定します。

- scalar operation reconciliationをoptional future-v1 Store capabilityとして **採用**
- base `UsageStore` のsource compatibilityを維持
- 共通read-only `absent` / `active` / `expired` / `settled` 語彙を採用
- backend/transport failure、unsupported/corrupt state、trusted-input mismatchを`absent`へ変換せずindeterminate / fail closed
- reconciliation中にsecond reservation、liability、renew、settle、recovery、replay state mutationを行わない
- Memory / Redis / Firestoreでoptional interfaceを実装し、Cloudflareはauthenticated reconciliation subpathで同じcore vocabularyを提供
- portable scalar reconciliation conformanceを追加し、provider-specific lost-ACK / time / durability / failover evidenceを別途維持
- v0.8 reconciliationはscalar-only。generic vector initial-reserve ambiguityはfail closedのまま
- business-result replay / business-side idempotencyはapplication-ownedのまま

## 判定

**v0.8.0 source releaseは完了。次product decision gateはv0.9.0で、#116〜#127 safety hardeningを先に閉じ、その後#76 + #82 + #99へ進みます。**

v0.5-v0.7までのresolved correctness gateをcarry forwardし、#81はprovider-neutral contract、built-in Store support matrix、portable conformance、Cloudflare provider-specific reconciliation evidenceを持ちます。

**v1.0 readinessは引き続きprovisionalです。** #83 / #84 / #81をoptional future-v1 capabilityとして採用し、**#116〜#127をv0.9 safety gateとして先に閉じてから#76 / #82 / #99のproduct decisionへ進みます。**

## v0.8 accounting boundary

application pathは互換な2系統になります。

- **scalar path** — `UsagePolicy` -> `UsageControl` -> `UsageStore`。optional `ProgressiveUsageStore` growth + optional scalar `OperationReconciliationStore` read-only statusあり
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

### #81 — operation reconciliation / status — v0.8で採用

v0.8ではoptional scalar read-only capabilityを採用します。Memory / Redis / Firestoreは `OperationReconciliationStore` を実装し、Cloudflareは `reconcileRemoteCloudflareOperation()` で同じresult vocabularyを提供しつつv0.7 reserve-specific aliasも維持します。reconciliationはcapacityを作らず、business replayも許可しません。unknown / prove不能stateはrejectしてfail closedのままです。portable conformanceでretained lifecycle status、expired state repeated readのnon-mutation、expected-state mismatchを検証します。

詳細は [Operation reconciliation / status](operation-reconciliation.ja.md) を参照。

### その他open capability

#76 / #82 / #99はv0.9 operational-usability decisionです。#99ではcanonical settlement-outcome integration vocabulary、invalid integration inputとservice unavailableを区別できるbounded diagnostics、privacy-safe lifecycle visibilityを扱います。second accounting authorityを作らずfail-closedを弱めないlow-risk / clearly usefulなものだけv1候補にします。

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

## v0.8 release evidence

v0.8.0 source releaseは、required release gateがgreenになったtagged commit `2877057c2015717f75decefd3f72c9731147fb8b` から作成済みです。implementation PR headとmerge後mainは同一Git treeで、release workflowもtagからpackage checkを再実行しました。完了したgate:

1. 5 packageをまとめて`0.8.0`へversion alignment
2. real Redisを含むNode 20 / 22 / 24 normal CI
3. Memory / Redis / Firestoreのportable scalar operation-reconciliation conformance、Cloudflare local workerd reconciliation integration、既存scalar/progressive/vector provider suite
4. Firestore Emulator / Cloudflare workerd integration
5. public reconciliation conformance exportを含むpackage tarball/content/version + clean-consumer verification
6. required CI / CodeQL green後にmerge
7. tested contentを`v0.8.0`としてtag / GitHub Release
8. npm publicationは独立authorizationがない限り実行しない

tag / GitHub Releaseは2026-08-22に公開済み。npm publicationは実施せずdeferredのままです。

## v0.7 release evidence

v0.7.0 source releaseは、required release gateがgreenになったtagged commit `bf4a6dfcf21c92634e4ba9ede5dcd889b3867612` から作成済みです。完了したgate:

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
3. supported Node.js floorを#105で明示freezeし、package `engines` / CI / security・support claim / clean-consumer evidenceを整合
4. Redis / Firestore / Cloudflareのpersisted-state upgrade / newer-schema fail-close / migration / rollback semanticsを#106で明示freeze
5. long-lived public package / subpath / API nameを最終review
6. 必要と判断したbreaking contract changeをv1 tag前に実施
7. `1.0.0` でfull package / integration / registry matrix green
8. explicit v1 source-release authorization

v0.6の直後に必ずv1へ進む必要も、future capabilityを全部v1前に完成させる必要もありません。stable boundaryは実需要とsafety evidenceに合わせます。

## Release / npm separation

GitHub source releaseとnpm publicationは別操作です。GitHub/source releaseがreadyという理由だけではnpm publishせず、#6をseparate explicit authorization付きfirst registry publication gateとして維持します。

## 現在の結論

**Current released source baseline: v0.8.0 — RELEASED / CLOSED。**

**Active product decision target: v0.9.0 — #116〜#127 safety hardeningを先に閉じ、その後#76 + #82 + #99 operational usability / dogfood diagnostics。** #108/#109/#110はsubscription-credit導入を簡単にするnon-blocking隣接workとして完了済みで、このhelper/docs surfaceはv1 gateにはしません。

**#83: optional progressive reservation growthとしてfuture v1へ採用。**

**#84: optional atomic heterogeneous vector usageとしてfuture v1へ採用。**

**#81: optional scalar read-only operation reconciliationとしてfuture v1へ採用。**

**次product decision target: v0.9.0 — #116〜#127を先に閉じ、その後#76 + #82 + #99。**

**v1.0は新featureなしのlater stable promotion。**

**npm publicationは引き続きdeferred / separate。**
