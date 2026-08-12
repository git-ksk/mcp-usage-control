# Roadmap

このRoadmapは、projectのcore categoryである **MCP execution boundaryのfailure-safe transactional usage enforcement** を守るためのものです。

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

このprojectはgeneric agent-budget、gateway、billing、governance、workflow productへ広げるのではなく、この境界のcorrectnessを深くします。戦略上の境界は [Project positioning](positioning.ja.md) を参照してください。

## v1 readiness status

v0.2後のcorrectness programは、v1.0 release-candidate / final-release準備へ進める状態まで完了しました。詳細な監査とblocker分類は [v1.0 readiness review](v1-readiness.ja.md) にまとめています。

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

現時点で、v1前に新しいruntime機能や再設計を必須とするknown correctness blockerはありません。

## Current priorities

1. **Release-candidate / API-freeze mechanics** — explicit authorization後にexact release commitを選び、5 packageを同時versioning、intended `Unreleased` entryだけをv1 sectionへ移動、full package/integration matrix、long-lived public name / semanticsの最終確認を行います。通常のreadiness workではtag / releaseしません。
2. **Cloudflare operational evidence (#24)** — documented real credential rotationを実行し、genuine platform-limit / overload / Free-plan exhaustion eventを安全に観測できた場合にcaptureします。post-v1 operational evidenceでありprovider-neutral core blockerではありません。Issueを閉じるためだけにshared Free-plan quotaを意図的に消費しません。
3. **First npm publication (#6)** — manual / deferredを維持します。registry publicationはsource readinessと別操作で、別途explicit authorizationが必要です。
4. **Failure semantics maintenance** — upstream protocol / provider変化に合わせ、crash recovery、ACK ambiguity、liability、cancellation、multi-round claim / recovery、Tasks lifetime、reconciliation、Store-specific durability assumptionを明示し続けます。
5. **Observer / event compatibility** — current event / log typeをAPI-freeze review対象として扱います。standalone wire-schema/version fieldは、実際のexternal telemetry / billing adapter需要が出た場合だけSemVerに従って追加し、enforcement transaction外を維持します。

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
