# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**MCP tool実行のまわりで、利用枠をfailure-safeに予約・確定するためのtransactional usage enforcementライブラリです。**

同時実行、retry、長時間処理、process crash、MCP multi-round flowがあっても、単純な `check -> execute -> increment` で利用枠を二重消費しないことを重視しています。

このprojectが扱うのは **tool executionとusage accountingの境界**です。payment processor、financial ledger、subscription system、OAuth provider、generic gateway、workflow engine、一般的なHTTP rate limiterにはしません。

> 初めてなら **[はじめに](docs/getting-started.ja.md)** からどうぞ。

## 現在の配布状況

**まだnpmへ公開していません。**

現在はrepository checkoutまたはlocal tarballを使います。npm publicationは別のmanual operationとして明示的にdeferredしています。

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

別projectへのinstallは [Source / local tarballから使う](docs/using-from-source.ja.md) を参照してください。

要件は **Node.js 20+ / ESM**。CIではNode.js 20 / 22、Redis 7、MCP TypeScript SDK v2 path、Cloudflare local/workerd、Firestore Emulator、package tarball、clean-consumer importを検証しています。

## Core lifecycle

```text
principal -> policy -> quote -> atomic reserve -> mark liable -> execute -> settle
                                      ^                           |
                                      |---------- renew ----------|
```

reservationは `pending` で始まり、metered costが発生し得るworkの直前で `cost-liable` になります。

- **pending** のままexpire: capacityを解放できる
- **cost-liable** になった後にexpire: actual usageが不明ならfull reservationを保守的に保持

execution開始後のprocess crashがautomatic refundにならない設計です。

## 普通のrate limiterと何が違う？

残り1 unitのとき、2 requestが両方

```text
remaining確認 -> paid work実行 -> counter加算
```

をすると、両方が同じ1 unitを見て実行開始できてしまいます。

`mcp-usage-control` はadmissionとreservationをauthoritative Storeの1 transitionとして扱います。複数budgetを使う場合は **全部reserveするか、1つもreserveしない** 方式です。

## Package構成

| Package | 役割 |
| --- | --- |
| `mcp-usage-control` | Core policy / Store contract、lease、settlement、observability、Memory reference Store、Store conformance runner |
| `mcp-usage-control-mcp` | MCP TypeScript SDK v2 wrapper、multi-round accounting、flow-store conformance runner |
| `mcp-usage-control-redis` | Redis `UsageStore` + shared Redis MCP flow store |
| `mcp-usage-control-cloudflare` | Cloudflare Durable Objects + SQLite Store、local / authenticated remote path |
| `mcp-usage-control-firestore` | server-side Firestore transactional Store |

## v1検討時のstable / deferred境界

| 領域 | 状態 | 境界 |
| --- | --- | --- |
| Core reserve / liability / renew / settle | **v1 stable候補** | failure-safe transaction contract |
| Multi-budget / replay protection | **v1 stable候補** | atomic + logical operation単位 |
| Redis / Cloudflare / Firestore Store | **v1 stable候補（provider constraint明記）** | durability / time / HA差は隠さない |
| `protectTool()` | **v1 stable候補** | single-round MCP tool |
| `protectMultiRoundTool()` | **v1 stable候補** | 現在対応する `input_required` accounting |
| shared / durable MRTR compare-and-consume | **v1方針** | sticky MCP sessionなしのcross-instance resume |
| first-class MCP Tasks wire/runtime adapter | **deferred / upstream experimental** | accounting semanticsは完成、stable adapterは未宣言 |
| 新stateless MRTR claim mode | **deferred** | 現行shared one-time claimより明確な利点なし |
| billing / financial ledger / workflow replay | **out of scope** | enforcement外 |

詳しいblocker分類は **[v1.0 readiness review](docs/v1-readiness.ja.md)** にまとめています。

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
        { key: `day:user:${request.principal.id}:2026-08-13`, limit: 20 },
        { key: `month:user:${request.principal.id}:2026-08`, limit: 100 },
        { key: `month:tenant:${tenant}:2026-08`, limit: 2_000 },
      ],
    };
  },
};

const control = new UsageControl(new MemoryUsageStore(), policy);
```

どれか1つでもadmitできなければ、他budgetだけpartial reserveすることはありません。

## Retryとlogical operation

replay protectionのscopeは次です。

```text
(tenantId, principal.id, tool, operationId)
```

同じlogical invocationのretryではstableな `operationId` を使います。`operationId` はidempotency inputであり、authentication / authorization proofではありません。

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
  // metered cost 0を証明できる場合だけ0 settleにする
  await admission.lease.settle(admission.lease.reservedUnits, 'error');
  throw error;
}
```

長時間workではauthoritative executionが続く間leaseをrenewします。

admission成功時にはauthoritative Storeが算出した `remainingByBudget` も返ります。別layerでconfigured limitからremainingを再計算しないでください。

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

`protectTool()` はreserve、handler entry直前のliability、default heartbeat、normal success / MCP `{ isError: true }` / throwの分類、conservative settlementを担当します。ambiguous settlementをblind retryしません。

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

**accountingのためにsticky MCP sessionは不要です。** 必要な`UsageStore` / flow stateをsharedにすればfresh requestが別instanceへ着地できます。

business side effectのidempotency / result replayはapplication側の責務です。usage-flow tokenをconsumeできたことはdestructive operationをblind replayしてよい証明ではありません。

詳しくは [MCP integration](docs/mcp-integration.ja.md) / [MCP protocol conformance](docs/mcp-conformance.ja.md) を参照してください。

## MCP Tasks accounting

long-running Tasksのaccounting ruleはすでに定義済みです。

- task IDと独立してlogical operationごとにreservation 1回
- `working` だけでcost-liableとは判断しない
- metered work直前にliability
- authoritative workが続く間、または意図的なinput待ち中はserver-side renew
- `tasks/cancel` ACKだけではcost 0 / refundを証明しない
- pre-liability cancellationを証明できれば0 settle可能
- liable crash / unknown usageはconservative
- business task creation / result replayを `UsageStore` に入れない

upstream TasksのTypeScript integration surfaceがまだexperimentalなため、**stableなfirst-class Tasks adapterは現在宣言していません**。詳しくは [MCP Tasks の利用量 accounting](docs/mcp-tasks-accounting.ja.md) を参照してください。

## 本番Store

### Redis

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from 'mcp-usage-control-redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
const store = new RedisUsageStore(redis);
```

RedisはLuaでatomic transition、Redis server `TIME` でlease / tombstone判定を行います。ただしRedis atomicityはfinancial-ledger durabilityではありません。persistence / HAはdeployment要件に合わせて設計してください。

### Cloudflare Durable Objects

Durable Object + SQLite transaction domainを使います。外部applicationからのremote pathは明示authentication付きHTTPS gatewayです。network / timeout ambiguityはsurfaceし、blind retryしません。

real deployed dogfoodでは主要accounting pathを検証済みですが、Issue #24にはreal platform operationの追加観測が2件残っています。すべてのCloudflare platform-limit条件でproduction-provenと過剰claimはしません。

### Firestore

server-side Firestore transactionでadmission / settlement / expiry recoveryを行います。lease timeはhost clock + configurable expiry graceで、強く共有されるbudget documentはcontention hotspotになり得ます。

本番利用前に [Redis](docs/redis.ja.md) / [Cloudflare](docs/cloudflare.ja.md) / [Firestore](docs/firestore.ja.md) を確認してください。

## Third-party Storeを実装する場合

`UsageStore` のmethod名を実装しただけではsafeとは言えません。

**[Store実装contract](docs/store-contract.ja.md)** と再利用可能なrunnerを使います。

```ts
import { assertUsageStoreConformance } from 'mcp-usage-control/conformance';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';
```

portable conformanceはbehavioral state-machine compatibilityを証明します。persistence、failover、authoritative time、lost-ACK behaviorはbackend固有のevidenceが別途必要です。

## Observability

`UsageObserver` はenforcement transaction外のstructured lifecycle eventです。observer failureがdeny/errorをallowへ変えたりsettlement stateを変更したりすることはありません。

raw tool arguments / exception messageは自動収集しません。unique principal / operation / reservation / budget IDをmetric labelへ昇格しないでください。`projectUsageEvent()` はlow-cardinalityな運用log projectionを提供します。

observabilityはdurable billing ledgerではありません。

## Safety invariant

1. admission compare + reservationはauthoritative Storeの1 operation
2. participating budgetは全部atomic reserve、または全部失敗
3. replay identityは `(tenantId, principal.id, tool, operationId)`
4. metered execution前に `markLiable()`
5. pending expiryはrelease可、liable expiryはconservative retention
6. long-running active leaseはrenewable
7. `actualUnits <= reservedUnits`
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
- [MCP protocol conformance](docs/mcp-conformance.ja.md)
- [MCP Tasks の利用量 accounting](docs/mcp-tasks-accounting.ja.md)
- [Architecture](docs/architecture.ja.md)
- [Store実装contract](docs/store-contract.ja.md)
- [Redis](docs/redis.ja.md)
- [Cloudflare](docs/cloudflare.ja.md)
- [Firestore](docs/firestore.ja.md)
- [Observability](docs/observability.ja.md)
- [API reference](docs/api-reference.ja.md)
- [Project positioning](docs/positioning.ja.md)
- [Roadmap](docs/roadmap.ja.md)
- [v1.0 readiness review](docs/v1-readiness.ja.md)
- [Release policy](docs/releasing.ja.md)

Project policy: [Contributing](CONTRIBUTING.ja.md) · [Security](SECURITY.ja.md) · [Support](SUPPORT.ja.md) · [Code of Conduct](CODE_OF_CONDUCT.ja.md)

## Release boundary

v0.2.0は既存のhistorical GitHub/source release boundaryとして固定します。v0.2.0後の変更はfuture releaseがexplicitにauthorizeされるまで `Unreleased` にだけ記録します。

current source treeは **v1.0 release-candidate / final-release準備へ進める状態** と評価していますが、このrepo stateだけでv1 tag / GitHub Releaseを作ることはありません。

**npm publicationは別途explicit authorizationが必要で、まだ実施していません。**

## License

Apache-2.0
