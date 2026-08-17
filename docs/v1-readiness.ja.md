# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

この文書は、将来のv1.0に向けて蓄積したevidenceを記録する **readiness assessment** です。v1 release指示でも、取り消せないAPI-freeze decisionでもありません。

この文書だけでv1.0 tag、GitHub Release、npm publicationを実行しません。

## Status update — v0.6 progressive-growth判断

直近の次source releaseは **v0.6.0** です。v0.5.0はreleased stabilization baselineとして維持します。

repositoryは一度、current fixed-reservation / scalar-unit modelをそのままv1へfreezeできる地点まで到達しました。この結論は現行modelの内部整合性を示すevidenceとして有効ですが、final v1 surfaceを確定する前にもう1回pre-1.0 stabilization releaseを挟みます。

v0.6で#83の判断を明示確定します。

- base bounded fixed-reservation `UsageStore` contractはsource-compatibleのまま維持
- progressive reservation growthは`UsageLease.grow()` + optional `ProgressiveUsageStore`としてfuture v1へ **採用**
- stable `incrementId` + Store-issued `growthCursor`でlost-ACK replay fenceを構成
- original participating budget全体をatomicにgrowし、pending / liable semanticsを維持
- settlement / expiry後はreplayを含む全growth callをreject
- #84 heterogeneous multi-dimensional usageはv0.7.0の次decision target

これはrelease planningの変更であり、完了済みcorrectness workを巻き戻すものではありません。

## 判定

**v0.6.0 source-release preparationへGO。normal CI / package / provider integration gate通過が条件です。**

解決済みcorrectness / evidence gate:

- #77 — Firestore ambiguous commit / ACK loss semantics
- #78 — Firestore bounded cross-instance clock-skew safety
- #79 — Node.js 24 full compatibility-evidence matrix
- #85 — existing accounting bucketに対するmutable quota-limit semantics

これらの領域にv0.6.0を止める既知defectはありません。

**v1.0 readinessは引き続きprovisionalです。** #83は未決ではなく、proof済みoptional growth surfaceとしてfuture v1へ採用しました。#84以降は指定v0.x gateで判断します。

## v0.6 accounting boundary

v0.6.0はv0.5のproof済みcontractを維持しつつ、optional progressive growthを追加します。

- `UsagePolicy` quote -> atomic `UsageStore.reserve()`
- all-or-nothing multi-budget admission
- 1 reservationに参加する全budgetへ1つのscalar quoted / actual unit countを適用
- base `UsageStore`ではmetered work前にbounded fixed reservationを確保
- `ProgressiveUsageStore`ではsame reservationをstable increment identity + growth cursorでoptionalにgrow
- `actualUnits <= reservedUnits`
- replay identity `(tenantId, principal.id, tool, operationId)`
- `markLiable()` によるexplicit `pending -> cost-liable`
- renewable lease
- liability後expiryのconservative behavior
- identical settlement replay / conflicting-settlement rejection
- fail-closed storage semantics
- same-key mutable effective limitでもauthoritative reserved / consumed usageを維持
- documented deployment constraintを持つMemory / Redis / Cloudflare Durable Objects / Firestore Store
- single-round + supported multi-round MCP TypeScript SDK v2 accounting path
- sticky MCP session不要のshared / durable one-time multi-round flow claim
- enforcement outcomeを変更できないprovider-neutral observability
- portable `UsageStore` / `McpUsageFlowStore` conformance runner

second logical operationをaccounting-equivalentなtop-up workaroundとは扱いません。all dimensionのatomic admissionが必要な場合、dimension別independent reserveも同等代替とは扱いません。

## v1 scopeとして意図的に残す論点

### #83 — progressive reservation growth — v0.6で採用

v0.6 proofにより、progressive growthはbase `UsageStore`をmandatoryに変更せず、optional Store extensionとしてfuture v1 surfaceへ採用する。proof対象はatomic all-budget growth、deterministic increment replay identity、lost-ACK fence、pending/liable inheritance、conservative expiry/recovery、terminal-state reject、total successfully reserved capacity以内のsettlement。

Memoryをreference proofとし、Redisは1本のLua transaction、Cloudflare Durable ObjectsはSQLite `transactionSync` + schema v2 additive growth metadata、Firestoreはnext cursorをcallback外で固定した1 transaction retryで実装する。portable progressive conformanceにprovider-specific ambiguity/concurrency testを重ねる。

詳細は[Progressive reservation growth](progressive-reservation-growth.ja.md)と[Progressive MCP growth](progressive-mcp-integration.ja.md)を参照。

### #84 — heterogeneous multi-dimensional usage

v1へ入れる場合、API freeze前に次をproofする必要があります。

- required dimensionは全部atomic admit、またはnone commit
- logical operationごとにreplay identityは1つ
- 1 dimension内のhierarchical budgetを自然にcompose
- settlement / replay / expiry / lost-ACK semanticsをdeterministicに維持
- provider-neutralで、usage enforcementをbilling / pricing logicへ変えない
- built-in / third-party Store conformanceで必要transaction shapeを表現できる

safe vector modelがv1前に完成しなければ、v1はv0.5 scalar modelを維持し、後からcompatible extensionまたは必要に応じmajor-version extensionとして追加できます。

### その他open capability

#76 / #81 / #82も、以前post-v1と呼んだからという理由だけでv1から自動除外しません。low-riskで明確な価値があり、second accounting authorityを作らずfail-closedを弱めない場合だけv1候補にします。

first-class MCP Tasks integrationもupstream TypeScript protocol surface次第です。accounting lifecycle自体はすでに定義・proof済みです。

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

## v0.6 release check

v0.6.0 source tag / releaseを作る前に:

1. 5 packageを同時に `0.6.0` へversioning
2. Node 20 / 22 / 24 normal CI
3. Redis progressive conformance / lost-ACK integration、Cloudflare local-workerd progressive conformance / lost-growth-ACK、Firestore Emulator progressive conformance
4. package tarball / content / version + clean-consumer verification
5. 英日growth / state-machine / MCP / migration docs確認
6. required check green後にimplementation PR merge
7. v0.6.0 source tag / GitHub Releaseは別途明示承認がある場合だけ作成
8. npm publicationは独立承認がない限り実行しない

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

**次source release: v0.6.0。**

**v0.6.0 readiness: release preparation GO。normal CI / provider / package checks通過が条件。**

**#83: optional progressive reservation growthとしてfuture v1 stable surfaceへ採用。**

**#84: v0.7.0の次v1-scope decision target。**

**v1.0自体は新featureなしのstable promotion。**

**npm publication: 引き続きdeferred / separate。**
