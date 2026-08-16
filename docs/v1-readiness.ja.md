# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

この文書は、将来のv1.0に向けて蓄積したevidenceを記録する **readiness assessment** です。v1 release指示でも、取り消せないAPI-freeze decisionでもありません。

この文書だけでv1.0 tag、GitHub Release、npm publicationを実行しません。

## Status update — v1前にv0.5

直近の次source releaseは **v0.5.0** です。

repositoryは一度、current fixed-reservation / scalar-unit modelをそのままv1へfreezeできる地点まで到達しました。この結論は現行modelの内部整合性を示すevidenceとして有効ですが、final v1 surfaceを確定する前にもう1回pre-1.0 stabilization releaseを挟みます。

そのため、以前のreviewで「#83 / #84は確定post-v1」としたrelease-planning部分はcurrent planでsupersedeします。

- v0.5.0はbounded fixed-reservation modelを維持
- v0.5.0は1 reservationに参加する全budgetへ1つのscalar quoted / actual unit countを適用
- #83 progressive reservation growthはopenの **v1-scope candidate**
- #84 heterogeneous multi-dimensional usageもopenの **v1-scope candidate**
- safety guaranteeを十分なevidence付きで維持できない場合は、どちらもpost-v1へ残してよい

これはrelease planningの変更であり、完了済みcorrectness workを巻き戻すものではありません。

## 判定

**v0.5.0 stabilization / source releaseへGO。**

解決済みcorrectness / evidence gate:

- #77 — Firestore ambiguous commit / ACK loss semantics
- #78 — Firestore bounded cross-instance clock-skew safety
- #79 — Node.js 24 full compatibility-evidence matrix
- #85 — existing accounting bucketに対するmutable quota-limit semantics

これらの領域にv0.5.0を止める既知defectはありません。

**v1.0 readinessは意図的にprovisionalへ戻します。** v0.5運用後、#83 / #84と、stable API commitment後に追加しにくくなるlow-risk / high-value capabilityを明示再評価してfinal v1 scopeを決めます。

## v0.5 accounting boundary

v0.5.0はcurrent proof済みcontractを維持します。

- `UsagePolicy` quote -> atomic `UsageStore.reserve()`
- all-or-nothing multi-budget admission
- 1 reservationに参加する全budgetへ1つのscalar quoted / actual unit countを適用
- metered work前にbounded fixed reservationを確保
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

### #83 — progressive reservation growth

v1へ入れる場合、API freeze前に次をproofする必要があります。

- every incrementを全participating budgetへatomic admit、または一切applyしない
- top-up attemptごとのdeterministic retry / idempotency identity
- committed increment後のlost ACKでcapacityを二重追加しない
- pending / cost-liable distinctionを維持
- 1回以上のincrement後もexpiry / recoveryで正しいconservative chargeを維持
- settlementがsuccessfully reserved totalを超えない
- long-running / multi-round executionがcapacity獲得のためだけにsecond logical operationを作らない

proofがv1前に間に合わなければ、v1はv0.5 fixed-reservation modelを維持して後からtop-upを追加できます。

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

## v0.5 release check

v0.5.0 source tag / release前に:

1. 5 packageを同時に `0.5.0` へversioning
2. intended post-v0.4 changeを `0.5.0` changelog sectionへ移動
3. Node 20 / 22 / 24 normal CI
4. Redis / Cloudflare local-workerd / Firestore Emulator integration
5. package tarball / content / version + clean-consumer verification
6. README / roadmap / release docsがv0.5を直近release、v1を後続scope decisionとして説明していることを確認
7. release commit green後だけv0.5.0 source tag / GitHub Release
8. npm publicationは独立承認がない限り別工程

## 将来v1のrelease gate

将来v1.0をreleaseするのは次を満たした後です。

1. v0.5 stabilization / dogfoodで十分なoperational confidenceを得る
2. #83 / #84と他のdeliberate v1-scope candidateを明示accept / defer
3. long-lived public package / subpath / API nameを最終review
4. 必要と判断したbreaking contract changeをv1 tag前に実施
5. `1.0.0` でfull package / integration matrix green
6. explicit v1 source-release authorization

v0.5の直後に必ずv1へ進む必要も、future capabilityを全部v1前に完成させる必要もありません。stable boundaryは実需要とsafety evidenceに合わせます。

## Release / npm separation

GitHub source releaseとnpm publicationは別操作です。v0.5.0や将来v1.0のsource releaseがreadyでも、それだけでnpm publishしません。

## 現在の結論

**次source release: v0.5.0。**

**v0.5.0 readiness: normal release CI / packaging checkを条件にGO。**

**v1.0 scope / API freeze: 未確定。v0.5後に再評価。**

**#83 / #84: open v1-scope candidate。確定post-v1ではない。**

**npm publication: 引き続きdeferred / separate。**
