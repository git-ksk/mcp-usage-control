# Roadmap

このRoadmapは、projectのcore categoryである **MCP execution boundaryのfailure-safe transactional usage enforcement** を守るためのものです。

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

このprojectはgeneric agent-budget、gateway、billing、governance、workflow productへ広げるのではなく、この境界のcorrectnessを深くします。戦略上の境界は [Project positioning](positioning.ja.md) を参照してください。

## v1 readiness status

v0.2後のcorrectness programは、v1.0 release-candidate準備を継続できる状態まで完了しています。詳細な監査とblocker分類は [v1.0 readiness review](v1-readiness.ja.md) にまとめています。

v1判断前に完了したもの:

- current MCP `2026-07-28` / TypeScript SDK v2のfresh-request multi-round proof
- principal / tenant / tool / args binding付きone-time resumeとambiguous consumeのfail closed
- sticky MCP sessionなしでshared / durable compare-and-consumeを使うv1 MRTR方針の確定
- long-running MCP Tasks accounting semantics + core proof test
- usage accountingとbusiness task/result replayの明示分離
- third-party `UsageStore` / `McpUsageFlowStore` のnormative safety contract
- reusable portable conformance runner + package / clean-consumer検証
- public API / export / version、built-in Store、security、horizontal scale、Node support、CI、release / npm workflow監査
- README / API docs同期とstable / experimental / deferred境界の明示

元のreadiness監査後に追加されたpre-v1 evidence / contract gateは解決済みです。Firestore ambiguous-commit semantics (#77)、boundedなcross-instance clock-skew safety (#78)、Node 24 full-matrix evidence (#79)、same-key mutable quota-limit semantics (#85)を完了し、core transaction model自体の再設計は不要でした。

#83 / #84のAPI-freeze boundary decisionも確定しました。**v1はmetered work前にboundedなfixed reservationを確保し、1 reservationに参加する全budgetへ1つのscalar quoted / actual unit countを適用するcontractとしてfreezeします。** progressive reservation growth (#83) とheterogeneous per-dimension / vector accounting (#84) はopenのpost-v1 design / implementation trackとして残し、v1 blockerにはしません。

v1 contractでは、second logical operationを作る擬似top-upや、partial successによってall-or-nothing admissionを弱めるdimension別の独立reserveを回避策として推奨・保証しません。

## Current priorities

1. **Release-candidate / API-freeze mechanics** — #83 / #84 boundary decision確定後の段階として、explicit release authorizationがある場合にexact release commitを選び、5 packageを同時versioning、intended `Unreleased` entryだけをv1 sectionへ移動、full package/integration matrix、long-lived public name / semanticsの最終確認を行います。通常のreadiness workではtag / releaseしません。
2. **Cloudflare operational evidence (#24)** — documented real credential rotationを実行し、genuine platform-limit / overload / Free-plan exhaustion eventを安全に観測できた場合にcaptureします。post-v1 operational evidenceでありprovider-neutral core blockerではありません。Issueを閉じるためだけにshared Free-plan quotaを意図的に消費しません。
3. **First npm publication (#6)** — manual / deferredを維持します。registry publicationはsource readinessと別操作で、別途explicit authorizationが必要です。
4. **Failure semantics maintenance** — upstream protocol / provider変化に合わせ、crash recovery、ACK ambiguity、liability、cancellation、multi-round claim / recovery、Tasks lifetime、reconciliation、mutable-policy boundary、Store-specific durability assumptionを明示し続けます。
5. **Operational observability (#76, #82)** — current observer / event behaviorはv1でstableに保ち、より豊富なoperational snapshotやthreshold / exhaustion signalはauthoritative accounting state machine外のoptional toolingとして扱います。
6. **Post-v1 accounting extension (#83, #84)** — progressive reservation growthはfailure-safe top-up protocolをproofできた場合の比較的近いadditive候補とし、heterogeneous multi-dimensional usageはstable scalar modelへ互換的に追加できない場合にmajor-version contractも許容する広いdesign trackとして扱います。

## v1境界に対するIssue分類

元のreadiness review後に追加されたIssueは、次のように分類します。

| Issue | v1分類 | 現在のv1 status |
| --- | --- | --- |
| #76 operational usage snapshot | Post-v1 optional operational tooling | v1 blockerではない。current observability semanticsをv1境界とする |
| #77 Firestore ambiguous-commit reconciliation | Pre-v1 Firestore evidence / contract gate | **解決済み** — reserve ambiguityのfail closedとliability / renewal / settlement retry/replay evidenceを明文化・test済み |
| #78 Firestore cross-instance clock skew | Pre-v1 Firestore safety gate | **解決済み** — bounded / synchronized clockのdeployment contractとdeterministic multi-instance evidenceを追加済み |
| #79 Node 24 CI evidence | Pre-v1 release / support-policy gate | **解決済み** — Node 20 / 22 / 24で同じfull build / test / package / clean-consumer matrixを実行 |
| #81 operation reconciliation / status capability | Post-v1 capability | v1 blockerではない。proveできないstateはfail closedを維持 |
| #82 quota threshold / exhaustion signals | Post-v1 optional operational tooling | v1 blockerではない |
| #83 progressive reservation growth | Post-v1 additive feature候補 | **v1 decision確定** — fixed reservationをstable v1 contractとする。Issueはfailure-safe atomic top-up design用にopen維持 |
| #84 heterogeneous multi-dimensional usage | Post-v1 design候補 | **v1 decision確定** — participating budget全体へ1つのscalar unit countを適用するmodelをstable v1 contractとする。将来vector accountingはmajor-version変更になる可能性あり |
| #85 mutable quota-limit semantics | Pre-v1 policy / Store-contract gate | **解決済み** — same-key limit-change contractとMemory / Redis / Cloudflare / Firestore共通portable conformance evidenceを追加 |

この分類では、**既存のv1 support claimを成立させるために必要なcorrectness / safety evidence** と、**v1外に安全に残せる新しいcapability** を分けています。

## MCP-native correctness

protocol固有機能はexecution boundaryのaccounting safetyを変える場合だけcoreへ入れます。

### Multi-round request / response

**v1方針**は現行shared / durable flow claim + atomic compare-and-consumeです。

維持するinvariant:

- logical operationごとにreservation 1回
- client round-trip request stateのintegrity verification
- trusted principal / tenant / tool / args binding
- one-time resume claim
- mismatch時に正当なstateを保持
- ambiguous consume ACKのfail closed
- sticky MCP session不要
- execution開始後のconservative liability behavior

新しいstateless / client-carried claim designは、concurrency / ACK ambiguity下で同じinvariantをproofし、具体的なoperational advantageを示せるまでdeferredです。

stateless transportはstateless accountingを意味しません。

### MCP Tasks

[MCP Tasks の利用量 accounting](mcp-tasks-accounting.ja.md) で次を定義・proof済みです。

- task IDと独立してlogical operationごとに1 admission / reservation
- `working` から推測せずmetered work直前にliability
- authoritative execution / intentional input wait中のrenewal
- completion / failure / cancellation / abandonment / worker crash
- ambiguous reserve / liability / renew / settlementのconservative handling
- cooperative cancellation ACKだけではrefundしない
- business operationをblind replayしないreconciliation
- task / result / worker ownershipを `UsageStore` から分離

新しいcore primitiveは不要です。upstream TypeScript Tasks extension surfaceがexperimentalな間、first-class Tasks protocol integrationは **deferred / experimental** です。boundaryが変わるまでstable Tasks adapter supportとは宣伝しません。

## Third-party Store contract

予定していたinvariant kitは実装済みです。詳しくは [Store実装contract](store-contract.ja.md)。

portable runner:

```ts
import { assertUsageStoreConformance } from 'mcp-usage-control/conformance';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';
```

compatibleと主張するStoreは、対象に応じて少なくとも次をproofする必要があります。

- atomic all-or-nothing multi-budget admission
- concurrent admission correctness
- same-key authoritative usageをresetしないmutable effective-limit behavior
- logical-operation replay semantics
- idempotent liability / settlement replay
- pending / liableを区別したexpiry recovery
- renewable / resumable state
- conflicting settlement rejection
- binding-aware one-time MCP flow consume
- invalid / corrupt stateのfail closed

portable runner合格はproduction-safe claimの必要条件ですが十分条件ではありません。backend-specific durability、failover、authoritative time、lost-ACK evidenceが別途必要です。

## External billing / metering

境界を次のまま維持します。

```text
transactional enforcement core
        -> best-effort observer / stable package API
        -> optional billing/telemetry adapter
```

外部billing schemaがbalance、price、invoice、receipt、eventなど別guaranteeを持っても、次を弱めたり置き換えたりしません。

- atomic admission
- reservation
- cost-liability state
- idempotency
- lease / expiry recovery
- ambiguous settlementのconservative handling

financial-grade ledgerが必要なら別system boundaryに置きます。

## Post-v1 candidates

具体的なuser / integration需要があり、stable transaction modelを維持できる場合だけ追加します。

- #76のoperational snapshot / helper。second accounting sourceは作らない
- #81のoperation reconciliation / status capability。Storeがauthoritative stateをproofできる場合だけ提供
- #82のquota threshold / exhaustion helper。non-authoritative operational toolingとして提供
- #83のprogressive reservation growth。atomic top-up identity、replay、lost-ACK、expiry、settlement semanticsをproofできた場合の比較的近いadditive accounting extension
- #84のheterogeneous multi-dimensional usage。provider-neutral atomic vector modelをproofできた場合のみ追加し、representation / settlementがbreakingになるならv1 scalar contractを弱めずmajor-version concernとして扱う
- standalone versioned telemetry / event wire schema
- optional external billing / metering adapter
- additional production policy example
- upstream stabilizes後のfirst-class MCP Tasks adapter
- equivalent one-time / ambiguity proofを持つalternative MRTR claim representation
- 同じconformance / failure contractを満たすadditional provider Store

## Non-goals

core runtimeは以下にはしません。

- generic agent runtime / budget authority
- generic HTTP / API rate limiter
- payment processor / subscription checkout system
- OAuth / identity provider
- billing dashboard / pricing catalog
- financial-grade ledger
- gateway / router product
- vendor billing protocolそのもののimplementation
- arbitrary business side effectをreplayするworkflow engine
- ambiguous state-changing operationをblind retryするsystem

これらとのintegrationはexplicit adapter / policy boundaryで扱います。
