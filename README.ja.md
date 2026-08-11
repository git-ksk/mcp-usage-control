# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**MCP tool実行向けの、同時実行に強いusage enforcement runtimeです。**

`mcp-usage-control` は、Model Context Protocol (MCP) のtool実行を対象に、entitlement・usage budget・credit消費を安全に制御するprovider-neutral runtimeです。v0.1では、parallel call、retry、failure、長時間handler、process消失があってもadmission / settlementを壊しにくいことを中心にしています。

payment processor、MCP Gateway、OAuth provider、billing dashboard、一般的なrate limiter自体は対象外です。

## 現在の配布状況

**packageはまだnpmへ公開していません。** 初回registry publishが完了するまでは、repository checkoutまたはローカルでpackしたtarballを使ってください。現時点では `mcp-usage-control` / `mcp-usage-control-mcp` / `mcp-usage-control-redis` / `mcp-usage-control-cloudflare` をregistryからinstallできる前提にはしていません。

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

## なぜrate limiterではないのか

一般的なrequest rate limiterは「このrequestを開始してよいか」を主に判定します。しかしquotaがexecution中に消費される実resourceを表す場合、それだけでは不十分です。実行後にactual usageをsettleする必要があります。

単純な `check -> execute -> increment` はconcurrencyでraceします。budget残量が1のとき、2 requestが同時に残量1を観測し、両方がmetered upstream operationを実行してからusageをincrementすると、1 unitのcapacityに対して2 unitsのworkをadmitしてしまいます。

`mcp-usage-control` はexecution**前**にquota比較とreservation作成を1つのatomic store operationとして行います。admitされたcapacityを実行中holdし、execution boundaryでcost-liable化し、long-running workではrenewし、最後にactual usageへsettleします。retryやambiguous failureも単なるrequest countではなくstate machineとして扱います。

| Category | 主な関心 | `mcp-usage-control` の違い |
| --- | --- | --- |
| Rate limiter | 時間窓あたりのrequest数 | execution前にmetered capacityをreserveし、実行後にactual usageへsettleする。 |
| Billing/payment provider | invoice、payment、subscription | 意図的にscope外。moneyを処理せず、policy / entitlement decisionを入力として使う。 |
| Gateway policy | centralized access / routing control | gateway必須ではなく、provider-neutral storeでtool execution周辺を直接enforceできる。 |
| Transactional usage enforcement | admission + liability + settlement | これがprojectのcore category。 |

外部billing / metering schemaはstableなobserver/event adapterを通じて**enforcement transactionの後段**へ接続します。external schemaの都合でatomic admission、liability、idempotency、expiry recovery、ambiguous settlement semanticsを弱めません。

## Packages

- **`mcp-usage-control`** — core policy、atomic admission contract、renewable / resumable lease、settlement、idempotency、provider-neutral observability hook、in-memory reference store。
- **`mcp-usage-control-mcp`** — `@modelcontextprotocol/server` v2 single-round toolに加え、opt-inの `input_required` suspend/resume accountingへ対応するadapter。
- **`mcp-usage-control-redis`** — LuaとRedis server timeを使うatomic Redis store。optionalなexpiry-recovery observabilityにも対応。
- **`mcp-usage-control-cloudflare`** — Cloudflare Durable Objects + SQLite store。Worker-localとauthenticated remote-client pathを提供。

4 packageともESM / Node.js 20+です。

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

## Provider-neutral observability

optional observerを付けると、telemetry / billing vendorへcoreを結合せずstructured lifecycle eventを受け取れます。

```ts
import { UsageControl, type UsageObserver } from 'mcp-usage-control';

const observer: UsageObserver = {
  onEvent(event) {
    console.log(JSON.stringify(event));
  },
};

const store = new RedisUsageStore(redis, { observer });
const control = new UsageControl(store, policy, {
  observer,
  metadata: { service: 'my-mcp-server', environment: 'staging' },
});
```

eventはadmission accepted / denied、settlement completed、expiry recovery、policy / store errorを扱います。observer deliveryは **best-effortでenforcement outcomeの外側** です。返されたPromiseはawaitせず、observer failureがquota stateを変更することはありません。`onEvent()` 自体はinlineで呼ばれるため、同期処理は軽量にしnetwork / durable I/Oはoffloadしてください。tool argumentsとraw exception messageは自動収集せず、custom metadataは明示opt-inです。

同一内容のidempotent settlement replayでも同じ `settlement.completed` eventが再発火する場合があります。二重計上を避けたいanalyticsは `(reservationId, actualUnits, outcome)` 等のstable keyでdedupeしてください。event stream自体はtransactional ledgerではありません。

runtime IDはhigh-cardinalityになり得ます。unique principal / operation / reservation / user-specific budget IDをmetric labelへ使わないでください。event field、privacy指針、Redis aggregate recovery、replay guidance、delivery guaranteeは [Observability](docs/observability.ja.md) を参照してください。

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

### Multi-round `input_required`

`protectTool()` 自体はsingle-roundのままで、`input_required` は引き続き明示rejectします。fresh MCP retry requestをまたぐlogical operationにはopt-inの `protectMultiRoundTool()` を使います。

multi-round wrapperは初回roundだけreserveします。usage leaseはserver-sideに保持し、wire上の `requestState` はintegrity-protectedなopaque flow referenceへ置換します。MCP serverの `requestState.verify` hookでretry stateを検証・decodeした後、同じreservationへ再attachします。server-side `McpUsageFlowStore` はtrusted principal / tool / args bindingをatomicに比較し、resume tokenをexactly one callerへconsumeする必要があります。

`MemoryMcpUsageFlowStore` はsingle-process reference implementationです。horizontal scaleするserverでは同じatomic compare-and-consume contractを満たすshared/durable flow storeが必要です。suspended leaseは明示的な `suspendTtlMs` を持ち、abandonされたcost-liable flowはexpiry時にfull reserved chargeを維持します。

one-time resume tokenにより同じretryでhandlerへ二重再入場しません。ただし任意のbusiness side effectのgeneral exactly-onceやcompleted result replayを提供する仕組みではないため、destructive / external operationでは既存のbusiness idempotency / result reconciliationを維持してください。

公式 `createRequestStateCodec()` の設定例とtrust boundaryの詳細は [MCP SDK v2 integration](docs/mcp-integration.ja.md) を参照してください。

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

## Cloudflare Durable Objects store

`mcp-usage-control-cloudflare` はSQLite-backed Durable Objectをtransaction domainとして使います。Worker内では `CloudflareUsageStore`、Cloudflare外のapplicationでは明示認証付きWorker gateway経由の `RemoteCloudflareUsageStore` を利用できます。operation / budget / outcome identifierはCloudflare boundary前にhash化し、tool argumentsは送りません。remote timeout / ACK ambiguityはblind retryせず表面化します。

Worker設定、privacy、cleanup / cost behavior、GCP等からの利用は [Cloudflare adapter](docs/cloudflare.ja.md) を参照してください。

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
14. observabilityはenforcement transactionの外側で、observer failureがallow / deny / settlement stateを変えません。
15. multi-round MCP retryで再reserveせず、original server-side usage leaseをresumeします。
16. clientを往復したMCP request stateはintegrity verificationとserver-side binding checkなしにaccounting authorityとして利用しません。
17. resume tokenはat-most-once consumeされ、mismatch callerが正規suspended flowをconsumeできません。

## Documentation

- [Source / local tarballから使う](docs/using-from-source.ja.md)
- [Getting started](docs/getting-started.ja.md)
- [MCP SDK v2 integration](docs/mcp-integration.ja.md)
- [Observability](docs/observability.ja.md)
- [Architecture / invariant](docs/architecture.ja.md)
- [Roadmap](docs/roadmap.ja.md)
- [Redis adapter](docs/redis.ja.md)
- [Cloudflare adapter](docs/cloudflare.ja.md)
- [API reference](docs/api-reference.ja.md)
- [Release policy](docs/releasing.ja.md)
- [Documentation index](docs/README.ja.md)

Project policy: [Contributing](CONTRIBUTING.ja.md) · [Security](SECURITY.ja.md) · [Support](SUPPORT.ja.md) · [Code of Conduct](CODE_OF_CONDUCT.ja.md)

## v0.1以降のscope

horizontal scaleするmulti-round MCP server向けのproduction-ready shared flow-store adapter、third-party store向けconformance-style invariant kit、enforcement transaction外のoptional external telemetry / billing adapterをfollow-upとして追跡します。billing provider、OAuth provider、dashboard、payment protocol、generic rate limitingはcore runtimeの対象外です。

priority / boundaryの詳細は [Roadmap](docs/roadmap.ja.md) を参照してください。

## License

Apache-2.0
