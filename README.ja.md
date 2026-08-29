# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**MCP tool実行のまわりで、利用枠をfailure-safeに予約・確定するtransactional usage enforcement libraryです。**

同時実行、retry、長時間処理、process crash、MCP multi-round flowがあっても、単純な `check -> execute -> increment` で利用枠をoversubscribeしないことを重視します。

このprojectが扱うのは **tool executionとusage accountingの境界**です。payment processor、financial ledger、subscription system、OAuth provider、generic gateway、workflow engine、一般的なHTTP rate limiterにはしません。

> 初めてなら **[はじめに](docs/getting-started.ja.md)** からどうぞ。

## 現在の配布状況

**まだnpmへ公開していません。**

`v0.10.0` がcurrent GitHub/source release baselineです。現在はrepository checkoutまたはlocal tarballを使います。npm publicationはIssue #6で追跡する別のmanual operationとして明示的にdeferredしています。

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

別projectへのinstallは [Source / local tarballから使う](docs/using-from-source.ja.md) を参照してください。

要件は **Node.js 22+ / ESM**。Node.js 20はEOL済みで、supported v1 runtime contractには含めません。現在のlegacy required-check policyを移行するまでは `test (20)` をcompatibility-only evidenceとして一時的に残し、supported runtime evidenceはNode.js 22 / 24です。CIではさらにRedis 7、MCP TypeScript SDK v2 path、Cloudflare local/workerd、Firestore Emulator、package tarball、clean-consumer importを検証しています。

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

5 packageのmanifestは `0.10.0` で揃っています。**v0.10.0がcurrent GitHub/source release baseline**で、npm registry publicationは引き続き意図的にdeferredです。

**現在の実行順序:** **v0.10.0はrelease済み**です。active product targetは **v0.11.0 / #152 -> #157 -> #105 + #106 -> #160 + #161 -> #24 -> #6** accounting-contract / reliability / compatibility / release-safety / final production-distribution evidence / public API-support freeze、最後にfeature追加なしの **v1.0.0** stable promotionです。Redis reliability follow-up #166は解決済みです。

## v0.5後に再評価するv1 scope

**v1 API freezeはまだfinalではありません**。v0.6 progressive growth、v0.7 atomic heterogeneous vectorに続き、v0.8ではbase `UsageStore`互換を維持したままread-only scalar operation reconciliationをoptional future-v1 Store capabilityとして採用しました。v0.10ではStore accounting modelを変えず、bounded operational usability、settlement outcome normalization/diagnostics、explicit scoped threshold helperを追加します。

| 領域 | current status | 境界 |
| --- | --- | --- |
| Core reserve / liability / renew / settle | **strong v1候補** | failure-safe transaction contract |
| Multi-budget / replay protection | **strong v1候補** | atomic + logical operation単位 |
| Redis / Cloudflare / Firestore Store | **strong v1候補（provider constraint明記）** | durability / time / HA差は隠さない |
| `protectTool()` | **strong v1候補** | single-round MCP tool |
| `protectMultiRoundTool()` | **strong v1候補** | current `input_required` accounting |
| shared / durable MRTR compare-and-consume | **current v1 direction** | sticky MCP sessionなしのcross-instance resume |
| progressive reservation growth (#83) | **v0.6で採用** | optional `UsageLease.grow()` / `ProgressiveUsageStore`; atomic / lost-ACK / provider proof |
| heterogeneous multi-dimensional usage (#84) | **v0.7で採用** | optional `VectorUsageControl` / `VectorUsageStore`; atomic per-dimension admission/growth/settlement + lost-ACK/provider proof |
| operation reconciliation/status (#81) | **v0.8で採用** | optional scalar `OperationReconciliationStore`; read-only `absent` / `active` / `expired` / `settled`、mismatch / unknownはfail closed、Store別support matrix |
| operational usability (#76/#99/#82) | **v0.10で採用** | non-authoritative snapshot/runtime identity、canonical settlement diagnostics、explicit scoped threshold evaluation |
| first-class MCP Tasks adapter | **upstream stabilization次第** | accounting semanticsは定義済み、stable adapter未宣言 |
| new stateless MRTR claim mode | **必要性が出るまでdeferred** | shared one-time claimより明確な利点なし |
| billing / financial ledger / workflow replay | **out of scope** | enforcement外 |

詳しくは **[v1.0 readiness review](docs/v1-readiness.ja.md)** と **[Roadmap](docs/roadmap.ja.md)** を参照してください。

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

Issue #24には追加のreal platform operational evidenceが残っています。optional `mcp-usage-control-cloudflare/auth` helperではcurrent / previous Bearer tokenを使ったcontrolled credential rotationを提供します。

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

`v0.10.0` がcurrent released source baselineです。package manifestは `0.10.0` です。active product targetは **v0.11.0 / #152 -> #157 -> #105 + #106 -> #160 + #161 -> #24 -> #6 accounting/completion/distribution/API freeze**、その後feature-free v1.0 promotionへ進みます。

**npm publicationは別途explicit authorizationが必要で、まだ完了していません。**

## License

Apache-2.0