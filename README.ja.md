# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**MCP tool実行向けの、同時実行に強いusage enforcement runtimeです。**

`mcp-usage-control` は、Model Context Protocol (MCP) のtool実行を対象に、entitlement・usage budget・credit消費を安全に制御するprovider-neutral runtimeです。v0.1では、parallel call、retry、failure、長時間handler、process消失があってもadmission / settlementを壊しにくいことを中心にしています。

payment processor、MCP Gateway、OAuth provider、billing dashboard、一般的なrate limiter自体は対象外です。

## 現在の配布状況

**packageはまだnpmへ公開していません。** 初回registry publishが完了するまでは、repository checkoutまたはローカルでpackしたtarballを使ってください。現時点では `mcp-usage-control` / `mcp-usage-control-mcp` / `mcp-usage-control-redis` をregistryからinstallできる前提にはしていません。

sourceからの簡易確認:

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

別projectから現在のpackageを使う場合は、ローカルで`.tgz`を生成してinstallします。正確な手順は **[Source / local tarballから使う](docs/using-from-source.ja.md)** を参照してください。CIでも同じtarballをcleanなconsumer projectへinstallして検証しています。

Node.js 20+が必要です。repository CIではNode.js 20 / 22、Redis 7、公式MCP TypeScript SDK v2のclient/handler pathをtestします。

## Core lifecycle

```text
principal -> policy/entitlement -> quote -> atomic reserve -> mark liable -> execute -> settle
                                                ^                          |
                                                |----------- renew --------|
```

重要なのはautomatic rollbackではなく **settlement** です。toolが失敗しても、その前に外部API、DB、compute resourceなどのmetered resourceを消費している場合があります。

reservationは最初 `pending` です。metered execution直前に `cost-liable` へ遷移します。pending leaseがexpireした場合はcapacityを解放できますが、cost-liable leaseがexecution開始後にexpireした場合はfull reservationを保守的に維持し、process crashがrefundになることを防ぎます。

## Packages

- **`mcp-usage-control`** — core policy、atomic admission contract、renewable lease、settlement、idempotency、in-memory reference store。
- **`mcp-usage-control-mcp`** — `@modelcontextprotocol/server` v2 single-round tool handler adapter。
- **`mcp-usage-control-redis`** — LuaとRedis server timeを使うatomic Redis store。

3 packageともESM / Node.js 20+です。

## Atomic multi-budget admission

1つのlogical invocationで、同じcostを複数budgetへ同時にreserveできます。例えばuser daily + user monthly + tenant monthlyです。

```ts
import { MemoryUsageStore, UsageControl, type UsagePolicy } from 'mcp-usage-control';

const policy: UsagePolicy = {
  quote(request) {
    const tenant = request.principal.tenantId ?? 'personal';
    return {
      decision: 'allow',
      units: request.tool === 'full_export' ? 5 : 1,
      budgets: [
        { key: `day:user:${request.principal.id}:2026-08-10`, limit: 20 },
        { key: `month:user:${request.principal.id}:2026-08`, limit: 100 },
        { key: `month:tenant:${tenant}:2026-08`, limit: 2_000 },
      ],
    };
  },
};

const control = new UsageControl(new MemoryUsageStore(), policy);
```

admissionは**all-or-nothing**です。参加budgetの1つでもquoted unitsを許可できなければ、他budgetだけがpartial reserveされることはありません。

1 budgetだけの場合は、簡易形として `budget` も利用できます。

## Idempotency scope

replay protectionは次のtuple単位です。

```text
(tenantId, principal.id, tool, operationId)
```

同じlogical invocationのretryではstableな `operationId` を使ってください。これはidempotency inputであり、authentication / authorization credentialではありません。

settled operationは有限期間tombstoneとしてreplay protectionされます。`MemoryUsageStore` / `RedisUsageStore` のdefault `idempotencyTtlMs` は24時間です。cost-liableになる前のpending reservationがexpireした場合はcapacityを解放し、recovery後にoperation IDを再利用できます。

## Coreを直接使う例

```ts
const admission = await control.reserve({
  operationId: 'logical-request-123',
  principal: { id: 'user-42', tenantId: 'org-7', plan: 'free' },
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
  // actualに発生したcostをsettleします。metered resource未消費を
  // 証明できる場合のみ0を使います。
  await admission.lease.settle(admission.lease.reservedUnits, 'error');
  throw error;
}
```

長時間実行ではactive leaseをrenewする必要があります。MCP adapterはdefaultでheartbeatを行います。coreを直接利用する場合は必要に応じて明示的にrenewしてください。

## MCP SDK v2 adapter

```ts
import { protectTool } from 'mcp-usage-control-mcp';

server.registerTool(
  'search',
  { /* input schema, description, ... */ },
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

**input schemaがないtool**では `noInput: true` を指定します。MCP SDK v2のpublic callback typeと実runtime dispatch shapeに差があり、さらにempty objectはempty schemaの正当なinputにもなり得るため、自動推測はしません。

`protectTool()` は以下をhandler boundaryで扱います。

- execution前のreserve。
- handler entry直前のcost-liable化。
- handler実行中のlease heartbeat。
- normal success / MCP `{ isError: true }` / thrown errorの区別。
- classifier failure時のfull reservationによる保守的settlement。
- ambiguous settlement failureをblind retryしないこと。

### `input_required` のsupport boundary

v0.1の `protectTool()` はMCP v2 multi-round `input_required` flowを**意図的に未対応**とします。fresh requestをまたぐ正しいreservation suspend/resume semanticsが必要なためです。adapterはsilentなroundごとの二重課金やreplay deadlockを避けるため、該当resultを検出すると保守的にsettleして `UnsupportedMcpUsageFlowError` を返します。将来設計はIssue #14で追跡します。

## Redis production store

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from 'mcp-usage-control-redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
const store = new RedisUsageStore(redis);
```

v0.1 Redis storeはmulti-budget reserve、`markLiable`、renew、settlement、expiry recovery、replay protectionを1つのRedis Cluster transaction domain内で処理します。lease / tombstoneの時刻はapplication `Date.now()` ではなくRedis server `TIME` を使います。

Lua atomicityとpersistence / failover durabilityは別です。必要なaccounting loss toleranceに合わせてRedis HA / persistenceを設定してください。financial-gradeなdurable ledgerが必要なら、enforcement stateを別のdurable systemへreconcileします。

production利用前に [Redis adapter](docs/redis.ja.md) を確認してください。

## Safety invariants

1. quota比較とreservation作成を1つのstore operationで行います。`check -> execute -> record` にはしません。
2. 適用されるすべてのbudgetをatomicにreserveするか、どれもreserveしません。
3. replay protectionは `(tenantId, principal.id, tool, operationId)` 単位です。
4. metered execution boundaryへ入る時点でcost-liableへ遷移します。
5. expired pending reservationはcapacityを解放し、expired cost-liable reservationはfull chargeを維持します。
6. long-running active leaseはrenew可能です。
7. v0.1では `actualUnits <= reservedUnits` が必要です。
8. identical settlement replayはidempotent、conflicting settlementはfailします。
9. MCP `isError: true` をsuccessとして分類しません。
10. cost-classification failureでは保守的settlement後にerrorを表面化します。
11. ambiguous settlement failureをblind retryしません。
12. storage failureをadmissionのallowへ変換しません。
13. Redis lease / tombstone時刻はapplication hostではなくRedisから取得します。

## Documentation

- [Source / local tarballから使う](docs/using-from-source.ja.md)
- [Getting started](docs/getting-started.ja.md)
- [MCP SDK v2 integration](docs/mcp-integration.ja.md)
- [Architecture / invariant](docs/architecture.ja.md)
- [Redis adapter](docs/redis.ja.md)
- [API reference](docs/api-reference.ja.md)
- [Release policy](docs/releasing.ja.md)
- [Documentation index](docs/README.ja.md)

Project policy: [Contributing](CONTRIBUTING.ja.md) · [Security](SECURITY.ja.md) · [Support](SUPPORT.ja.md) · [Code of Conduct](CODE_OF_CONDUCT.ja.md)

## v0.1以降のscope

provider-neutral observability hookと、本物の `input_required` suspend/resume accountingはfollow-upとして追跡します。billing provider、OAuth provider、dashboard、payment protocol、generic rate limitingはcore runtimeの対象外です。

## License

Apache-2.0
