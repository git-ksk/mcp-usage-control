# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**MCP toolの実行・retry・障害が重なっても、利用枠を正しく守るためのlibraryです。**

`mcp-usage-control` は、paid model call、credit、export、search、job、plan quotaなど、MCP toolが実際に有限なresourceを消費する場合に使います。work開始前にusageをatomic reserveし、終了後にactual usageをsettleするため、同時実行、retry、process crash、lost ACKがあっても同じquotaを二重に使いません。

典型例は次のようなproductです。

```text
Free   -> 月50 credits
Plus   -> 月500 credits
search -> 1 credit
report -> 10 credits
```

残り10 creditsのときに10-credit jobが2件同時に来ても、両方を開始させません。paid work開始後にworkerが落ちた場合は楽観的にrefundしません。同じlogical operationのretryでは、別reservationを新規作成しないようreplay protectionが働きます。

### 向いているケース

- MCP toolが有料・有限resourceを消費する
- Free/Pro、user、tenant、daily、monthly quotaを同時実行下でも正しく守りたい
- retry、process loss、長時間処理、multi-round MCP flowが本番で起こり得る
- ambiguous backend failure時にfail-openするよりquota correctnessを優先したい

### 向いていないケース

- 単純なrequests-per-minute制限だけで十分
- billing、invoice、checkout、subscription management、financial ledgerが欲しい
- approximate / eventually consistentなglobal quotaで十分で、strict reservation semanticsが不要

> まず試すなら **[はじめに](docs/getting-started.ja.md)**。設計境界は **[Project positioning](docs/positioning.ja.md)** を参照してください。

## Safety propertyを実際に動かす

`pnpm example:free-plus` で、Free 50 / Plus 500 monthly creditsのself-verifying exampleを実行できます。Free残り10 creditsに対して10-credit reportを2件同時実行し、exactly oneだけadmitされなければexample自体が失敗します。[実行可能なFree / Plus credits example](examples/free-plus-credits/README.md) を参照してください。

## 現在の配布状況

**5 packageすべてをnpmへ `1.0.0` として公開済みです。** `v1.0.0` はcurrent stable GitHub/source release baselineでもあります。通常は必要なintegration layerとStore backendだけをinstallしてください。GitHub Release tarballはreproducibleなsource-release artifactとして引き続き利用できます。non-registry workflowは **[Source / local tarballから使う](docs/using-from-source.ja.md)** を参照してください。

要件は **Node.js 22+ / ESM**。CIではNode.js 22/24、Redis 7、MCP TypeScript SDK v2 path、Cloudflare local/workerd、Firestore Emulator、package tarball、clean-consumer importを検証しています。

## Core lifecycle

```text
principal -> policy -> quote -> atomic reserve -> mark liable -> execute -> settle
                                      ^                           |
                                      |---------- renew ----------|
```

reservationは `pending` で始まり、metered costが発生し得るworkの直前で `cost-liable` になります。

- **pending** のままexpire: capacityを解放できる
- **cost-liable** 後にexpire: actual usageが不明ならfull reservationを保守的に保持

execution開始後のprocess crashがautomatic refundにならない設計です。

## 普通のrate limiterとの違い

残り1 unitのときに2 requestが両方

```text
remaining確認 -> paid work実行 -> counter加算
```

を行うと、両方が同じ残量を見て実行を始められます。

`mcp-usage-control` はadmissionとreservationをauthoritative Storeの1 transitionとして扱います。複数budgetを使う場合は **全部reserveするか、1つもreserveしない** 方式です。

## Package構成

| Package | 役割 |
| --- | --- |
| `mcp-usage-control` | Core policy / Store contract、lease、settlement、observability、Memory reference Store、Store conformance runner |
| `mcp-usage-control-mcp` | MCP TypeScript SDK v2 wrapper、multi-round accounting、flow-store conformance runner |
| `mcp-usage-control-redis` | Redis `UsageStore` + shared Redis MCP flow store |
| `mcp-usage-control-cloudflare` | Cloudflare Durable Objects + SQLite Store、local / authenticated remote path |
| `mcp-usage-control-firestore` | server-side Firestore transactional Store |

packageは3層で考えると分かりやすいです。

```text
mcp-usage-control
= usage controlのエンジン本体

mcp-usage-control-mcp
= そのエンジンをMCPへ取り付けるintegration kit

redis / cloudflare / firestore
= authoritative stateの保存先
```

典型的な組み合わせ:

| 作るもの | まず使うpackage |
| --- | --- |
| 普通のMCP TypeScript server | core + MCP adapter + production Storeを1つ |
| lifecycleを自前で制御するcustom integration | core + production Storeを1つ |
| local test / short-lived single-process prototype | core + `MemoryUsageStore` だけでも可 |

普通のapplicationで5 package全部をinstallする必要はありません。必要なintegration layerと、deploymentに合うStore backendを1つ選びます。

5 package manifestは `1.0.0` で揃っており、5 packageすべてnpm公開済みです。**v1.0.0がcurrent stable GitHub/source / npm baseline**です。


## v1 status

`v1.0.0` はv0.13までにhardenしたfreeze済みaccounting lifecycle / Store contractをfeature-freeでstable promotionしたreleaseです。stable promotionで新しいaccounting model、Store contract、billing authorityは追加していません。

Core lifecycle、Redis / Cloudflare / Firestore Store、single-round `protectTool()`、current multi-round accountingはv1 stable evidenceの対象です。first-class MCP Tasks runtime supportはupstream stabilization待ちです。billing、financial ledger、gateway、workflow replayは引き続きscope外です。

詳細なrelease boundaryとevidenceは **[v1.0 readiness review](docs/v1-readiness.ja.md)** と **[Roadmap](docs/roadmap.ja.md)** を参照してください。

## Multi-budget admission

1回のinvocationを複数budgetへatomicに計上できます。

```ts
import { MemoryUsageStore, UsageControl, type UsagePolicy } from 'mcp-usage-control';

const policy: UsagePolicy = {
  quote(request) {
    const tenant = request.principal.tenantId ?? 'personal';
    return {
      decision: 'allow',
      units: request.tool === 'full_export' ? 5 : 1,
      budgets: [
        { key: `day:user:${request.principal.id}:2026-08-17`, limit: 20 },
        { key: `month:user:${request.principal.id}:2026-08`, limit: 100 },
        { key: `month:tenant:${tenant}:2026-08`, limit: 2_000 },
      ],
    };
  },
};

const control = new UsageControl(new MemoryUsageStore(), policy);
```

どれか1つでもadmitできなければ、他budgetだけpartial reserveしません。

## Retryとlogical operation

replay protectionのscopeは次です。

```text
(tenantId, principal.id, tool, operationId)
```

同じlogical invocationのretryではstableな `operationId` を使います。`operationId` はidempotency inputでありauthentication / authorization proofではありません。

## Core APIを直接使う

```ts
const admission = await control.reserve({
  operationId: 'logical-request-123',
  principal: { id: 'user-42', tenantId: 'org-7' },
  tool: 'search',
  args: { query: 'example' },
});

if (!admission.allowed) {
  throw new Error(`usage denied: ${admission.reason}`);
}

await admission.lease.markLiable();

try {
  const result = await performMeteredWork();
  await admission.lease.settle(1, 'success');
  return result;
} catch (error) {
  await admission.lease.settle(admission.lease.reservedUnits, 'error');
  throw error;
}
```

長時間workではauthoritative executionが続く間leaseをrenewします。

admission成功時にはauthoritative Storeが算出した `remainingByBudget` も返ります。別layerでconfigured limitからremainingを再計算しないでください。

budget window / lifetime semanticsはapplication-ownedです。同じ `budget.key` は同じaccounting bucketを表し、keyを変えると別bucketになります。Core / Storeはdaily / monthly reset boundaryを推測せず、non-zero budgetを自動resetしません。

`MemoryUsageStore.stats()` はretained accounting / replay stateを返すもので、consumed quotaではありません。

### Memory Storeを長時間使う場合

`MemoryUsageStore` はprocess-localですが、controlled single-process deploymentではoperation / tombstoneとnon-zero budget keyの保持数をbounded化できます。上限到達時はauthoritative accounting stateをevictせずfail closedします。`stats()` で保持量を監視し、終了済みtime-window budgetだけを `retireBudgetKey()` で明示退役できます。

horizontal scaleやrestart durabilityが必要ならprovider-backed shared Storeを使ってください。詳しくは [Memory Storeの長期運用](docs/memory-store.ja.md)。

## MCP TypeScript SDK v2

### Single-round tool

```ts
import { protectTool } from 'mcp-usage-control-mcp';

server.registerTool(
  'search',
  { /* schema and metadata */ },
  protectTool(
    {
      control,
      tool: 'search',
      principal: ctx => ({ id: ctx.http.authInfo.subject }),
      operationId: (_args, ctx) => String(ctx.mcpReq.id),
    },
    async (args, ctx) => search(args, ctx),
  ),
);
```

`protectTool()` はreserve、handler entry直前のliability、default heartbeat、result classification、conservative settlementを担当し、ambiguous settlementをblind retryしません。

### Multi-round `input_required`

fresh MCP requestをまたぐlogical operationには `protectMultiRoundTool()` を使います。

- first roundで1回だけreserve
- resumable leaseはserver-side保持
- request stateはintegrity verification必須
- trusted principal / optional tenant / tool / original args hashへbinding
- matching resume flowをatomic one-time consume
- new reservationではなく元leaseへreattach
- replay / mismatch / expiry / corruption / ambiguous consumeはfail closed

`MemoryMcpUsageFlowStore` はtest / single-process専用です。horizontal scaleでは `RedisMcpUsageFlowStore` などshared / durable Storeを使います。

**accountingのためにsticky MCP sessionは不要です。**

business side effectのidempotency / result replayはapplication側の責務です。

## MCP Tasks accounting

long-running Tasksのaccounting ruleは定義・proof済みです。

- task IDと独立してlogical operationごとにreservation 1回
- `working` だけでcost-liableとは判断しない
- metered work直前にliability
- authoritative work / intentional input wait中はserver-side renew
- `tasks/cancel` ACKだけではcost 0 / refundを証明しない
- liable crash / unknown usageはconservative
- business task creation / result replayは `UsageStore` 外

upstream Tasks TypeScript integration surfaceがexperimentalなため、stable first-class Tasks adapterはまだ宣言しません。

## 本番Store

### Redis

RedisはLuaでatomic transition、Redis server `TIME` でlease / tombstone判定を行います。Redis atomicityはfinancial-ledger durabilityではないためpersistence / HAはdeployment要件に合わせます。

### Cloudflare Durable Objects

Durable Object + SQLite transaction domainを使います。remote pathは明示authentication付きHTTPS gatewayで、network / timeout ambiguityはsurfaceしblind retryしません。

real deployed dogfoodではmain accounting pathに加え、overlap acceptance、real caller cutover、rotated-out credential rejectionまで含むzero-downtime credential rotationを確認しました。Durable Object / accounting identityも維持されています。genuine Workers Free-plan exhaustion / platform overloadは自然観測していないため、全platform-limit条件まで実証済みとはclaimしません。optional `mcp-usage-control-cloudflare/auth` helperではcurrent / previous Bearer tokenを使ったcontrolled credential rotationを提供します。

### Firestore

server-side Firestore transactionでadmission / settlement / expiry recoveryを行います。supported recovery profileではhost clockをbounded / synchronizedにし、`expiryGraceMs` をmaximum expected positive clock lead + margin以上に設定します。強く共有されるbudget documentはcontention hotspotになり得ます。

本番利用前に [Redis](docs/redis.ja.md) / [Cloudflare](docs/cloudflare.ja.md) / [Firestore](docs/firestore.ja.md) を確認してください。

## Third-party Storeを実装する場合

`UsageStore` のmethod名を実装しただけではsafeとは言えません。

**[Store実装contract](docs/store-contract.ja.md)** とrunnerを使います。

```ts
import { assertUsageStoreConformance } from 'mcp-usage-control/conformance';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';
```

portable conformanceはbehavioral state-machine compatibilityを証明します。persistence、failover、authoritative time、lost-ACK behaviorはbackend固有のevidenceが別途必要です。

## Observability

`UsageObserver` はenforcement transaction外のstructured lifecycle eventです。observer failureがdeny/errorをallowへ変えたりsettlement stateを変更したりすることはありません。

raw tool arguments / exception messageは自動収集しません。`projectUsageEvent()` はlow-cardinalityな運用log projectionを提供します。

v0.10では `mcp-usage-control/operational` にprovider-neutral operational helper、`mcp-usage-control/settlement-outcomes` にcanonical settlement vocabulary/diagnostics、`mcp-usage-control/thresholds` にpureなscoped threshold helperを追加します。いずれもnon-authoritativeで、second accounting ledgerを作りません。

observabilityはdurable billing ledgerではありません。

詳しくは [Observability](docs/observability.ja.md) と [Operational usability](docs/operational-usability.ja.md)。

## Safety invariant

1. admission compare + reservationはauthoritative Storeの1 operation
2. participating budgetは全部atomic reserve、または全部失敗
3. replay identityは `(tenantId, principal.id, tool, operationId)`
4. metered execution前に `markLiable()`
5. pending expiryはrelease可、liable expiryはconservative retention
6. long-running active leaseはrenewable
7. scalar modelでは `actualUnits <= reservedUnits`
8. identical settlement replayはretention中idempotent、conflictはfail
9. storage failureをallowへ変えない
10. ambiguous state-changing outcomeをblind retryしない
11. MCP multi-round resumeはintegrity-verified / binding-aware / one-time
12. resumeで2個目のusage reservationを作らない
13. client liveness / cancel ACKだけでrefund safeとは判断しない
14. observability failureはenforcement stateを変えない
15. business-operation replayとusage accountingを分離する

## ドキュメント

- [はじめに](docs/getting-started.ja.md)
- [Troubleshooting](docs/troubleshooting.ja.md)
- [Source / local tarballから使う](docs/using-from-source.ja.md)
- [MCP integration](docs/mcp-integration.ja.md)
- [サブスク型MCP creditsの実装パターン](docs/subscription-credits.ja.md)
- [MCP protocol conformance](docs/mcp-conformance.ja.md)
- [Cross-capability safety regression matrix](docs/safety-regression-matrix.ja.md)
- [MCP Tasks の利用量 accounting](docs/mcp-tasks-accounting.ja.md)
- [Architecture](docs/architecture.ja.md)
- [Memory Storeの長期運用](docs/memory-store.ja.md)
- [Store実装contract](docs/store-contract.ja.md)
- [Operation reconciliation / status](docs/operation-reconciliation.ja.md)
- [Redis](docs/redis.ja.md)
- [Cloudflare](docs/cloudflare.ja.md)
- [Firestore](docs/firestore.ja.md)
- [Observability](docs/observability.ja.md)
- [Operational usability](docs/operational-usability.ja.md)
- [API reference](docs/api-reference.ja.md)
- [Project positioning](docs/positioning.ja.md)
- [Roadmap](docs/roadmap.ja.md)
- [v1.0 readiness review](docs/v1-readiness.ja.md)
- [Release policy](docs/releasing.ja.md)

Project policy: [Contributing](CONTRIBUTING.ja.md) · [Security](SECURITY.ja.md) · [Support](SUPPORT.ja.md) · [Code of Conduct](CODE_OF_CONDUCT.ja.md)

## Release boundary

`v1.0.0` がcurrent stable released source baselineです。v1-blocker closure trancheは完了状態を維持し、stable promotionで新しいaccounting modelは追加していません。#6はseparate explicit authorization必須のnpm-publication gateとして維持します。

**npm publicationは別途explicit authorizationが必要で、まだ完了していません。**

## License

Apache-2.0