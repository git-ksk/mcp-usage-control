# MCP integration — v0.1

[English](mcp-integration.md) | [日本語](mcp-integration.ja.md)

`mcp-usage-control-mcp` はcore lifecycleを `@modelcontextprotocol/server` v2 tool handlerへ接続するadapterです。single-round toolには `protectTool()`、MCP v2 `input_required` の明示的なsuspend/resume flowには `protectMultiRoundTool()` を使います。

> **現在の配布状況:** adapterはまだnpmへ公開していません。[Source / local tarballから使う](using-from-source.ja.md) に従ってlocal core + MCP tarballをinstallし、`@modelcontextprotocol/server@2.0.0` を組み合わせてください。

adapter自体はauthenticationやsubscription判定を行いません。application側でtrustedな `Principal` とlogical `operationId` を導出します。

## Single-round protected toolを登録

```ts
import { protectTool } from 'mcp-usage-control-mcp';

server.registerTool(
  'search',
  {
    description: 'Search the catalog',
    inputSchema: z.object({ query: z.string() }),
  },
  protectTool(
    {
      control,
      tool: 'search',
      principal: ctx => getPrincipalFromTrustedAuthContext(ctx),
      operationId: (args, ctx) => getStableInvocationId(args, ctx),
    },
    async ({ query }) => ({
      content: [{ type: 'text', text: await searchCatalog(query) }],
    }),
  ),
);
```

MCP SDK本来のargument validationはwrapped application handlerより前にそのまま動作します。

## Input schemaがないtool

`noInput: true` を明示します。

```ts
server.registerTool(
  'ping-backend',
  { description: 'Check backend health' },
  protectTool(
    {
      control,
      tool: 'ping-backend',
      noInput: true,
      principal: ctx => getPrincipalFromTrustedAuthContext(ctx),
      operationId: (_args, ctx) => getStableInvocationId(undefined, ctx),
    },
    async (_args, ctx) => ({
      content: [{ type: 'text', text: await pingBackend(ctx) }],
    }),
  ),
);
```

このflagは意図的に明示します。SDK public TypeScript callback modelではno-input toolを `(ctx)` と表現しますが、server dispatchでは `({}, ctx)` として観測される場合があります。一方 `{}` はempty object schemaの正当なinputでもあるためruntime値だけで推測しません。`noInput: true` では `args === undefined` と正しい `ServerContext` へnormalizeします。

## Single-round execution lifecycle

`protectTool()` のadmission後:

```text
reserve -> markLiable -> heartbeat -> handler -> stop heartbeat -> classify -> settle
```

liability boundaryはapplication handler entry直前です。generic adapterはprovider-specificな実コスト発生点を知らないため保守的な境界を採用します。より遅いprovider-awareな `markLiable()` が必要ならcore lifecycleを直接利用してください。

## MCP v2 `input_required` suspend/resume

MCP 2026-eraの `input_required` は、同じlogical callをfresh MCP requestとしてretryします。fresh JSON-RPC request IDごとにusage reservationを作り直してはいけません。

このflowでは `protectMultiRoundTool()` を使います。初回roundだけ `operationId()` を呼んでreserveし、後続roundは同じserver-side leaseへ再attachします。policy quoteやreserveを再実行しません。

### Request-state integrity

MCP `requestState` はclientを往復するためuntrustedです。公式SDKのverification seamを設定し、同じcodecのmint関数をwrapperへ渡します。

```ts
import {
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  McpServer,
} from '@modelcontextprotocol/server';
import {
  MemoryMcpUsageFlowStore,
  protectMultiRoundTool,
  type McpUsageRequestStatePayload,
} from 'mcp-usage-control-mcp';

const stateCodec = createRequestStateCodec<McpUsageRequestStatePayload>({
  key: process.env.REQUEST_STATE_SECRET!, // 32 bytes以上、server-side secret
  ttlSeconds: 600,
});

// per-request createMcpHandler factoryの外側で保持します。
// 複数processへrequestが分散する場合はshared/durable implementationを使います。
const flowStore = new MemoryMcpUsageFlowStore();

const protectedConfirm = protectMultiRoundTool(
  {
    control,
    tool: 'confirm-write',
    noInput: true,
    principal: ctx => getPrincipalFromTrustedAuthContext(ctx),
    operationId: () => createStableLogicalOperationId(),
    flowStore,
    requestState: { mint: payload => stateCodec.mint(payload) },
    suspendTtlMs: 5 * 60_000,
    maxRounds: 4,
  },
  async (_args, ctx, flow) => {
    if (flow.round === 0) {
      return inputRequired({
        inputRequests: {},
        // application側の任意state。wireへそのまま信用して出さず、
        // wrapperがserver-sideに保持してsigned flow tokenへ置換します。
        requestState: 'awaiting-confirmation',
      });
    }

    if (flow.applicationRequestState !== 'awaiting-confirmation') {
      throw new Error('invalid application phase');
    }

    return { content: [{ type: 'text', text: 'done' }] };
  },
);

const handler = createMcpHandler(() => {
  const server = new McpServer(
    { name: 'example', version: '1.0.0' },
    { requestState: { verify: stateCodec.verify } },
  );
  server.registerTool('confirm-write', { description: 'Confirm then write' }, protectedConfirm);
  return server;
});
```

`ctx.mcpReq.requestState()` がverified decoded payloadではなくraw stringなら、wrapperは `McpUsageResumeError` でfail-closeします。verificationを無効にしたままclient echoのstringを手動でaccounting authorityとして信用しないでください。

### Server-side flow store

clientへ渡すのはintegrity-protectedなopaque flow referenceだけです。resumable usage leaseを含むtrusted recordはserver-sideに残します。

`McpUsageFlowStore.consume(flowId, binding)` はsecurity-criticalなcontractです。

1. 保存済みbindingを現在のtrusted principal / tenant / tool / canonical args hashと比較する。
2. mismatchなら正規flowを**consumeせず**no recordを返す。
3. matchならflowをatomicにexactly one callerへconsumeして返す。

`MemoryMcpUsageFlowStore` はtest / single process向けです。modern `createMcpHandler` requestが別instanceへ到達し得るhorizontal scale構成には使えません。Redis、transactional DB、Durable Objects等、atomic compare-and-consumeを実装できるshared storeを利用してください。

### Lifecycle / abandonment

multi-round lifecycle:

```text
reserve -> markLiable -> handler
  -> input_required
  -> stop heartbeat -> renew(suspendTtlMs) -> persist flow -> signed requestStateを返す
  -> fresh request -> verify requestState -> atomic consume -> resume lease -> renew
  -> handler -> ... -> classify -> settle
```

reservationは初回application handlerへ入る前にcost-liableです。そのためsuspended flowがabandonされた場合や、one-time resume token claim後にprocess crashした場合は、lease expiryでfull reserved chargeを保守的に維持します。実行済みかもしれないworkをsilent refundしません。

`maxRounds` で繰り返しsuspendを上限化します。超過時はfull reservationをsettleして `McpUsageRoundsExceededError` を返します。

### Replay semantics

resume tokenはone-timeです。同じtokenのconcurrent identical resumeではapplication handlerへ再入場できるcallerは1つだけで、それ以外は `McpUsageResumeError` でfail-closeします。principal / tool / args mismatchのattemptは正規flowをconsumeできません。

これによりduplicate usage reservationと同じresume tokenによるduplicate handler entryを防ぎます。ただし任意のapplication side effectをexactly-onceにする仕組みではなく、token claim後にbusiness responseだけ失われた場合のcompleted result cache/replayも行いません。destructive / externally metered operationでは既存のbusiness idempotency / result reconciliationを併用してください。

### Logical operation ID

`operationId()` は初回roundだけ評価します。stable logical operation IDはtrusted lease stateで維持し、resume後は `flow.operationId` で参照できます。

multi-round accounting identityを各retryのfresh `ctx.mcpReq.id` から作らないでください。MCP clientは `input_required` fulfillment時にfresh request IDを使えます。

## Observability

MCP adapter側で別のtelemetry systemを定義しません。どちらのwrapperでも使用する `UsageControl` へprovider-neutralな `UsageObserver` を設定すると、direct coreと同じlifecycleでreserve / denial / settlement / error eventを受け取れます。storeがRedisの場合は同じobserverを `RedisUsageStore` にも渡すとexpiry recovery eventも含められます。

tool argumentsはusage eventへ自動コピーしません。privacy、cardinality、metadata、delivery semanticsは [Observability](observability.ja.md) を参照してください。

## Principal trust

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

principal / tenant / planはapplicationがすでにtrustしているserver-side contextから導出します。caller supplied accounting identityをauthorizationなしで信用しないでください。

## Operation ID / replay scope

core replay protectionのscope:

```text
(tenantId, principal.id, tool, operationId)
```

single-round toolでは `operationId` は同じlogical executionのretryでstable、intentional new executionではdifferentである必要があります。non-secretなidempotency identityでありauthorization proofではありません。

`ctx.mcpReq.id` はrequest-scoped用途やtestには使えますが、logical retry間でclient/hostが同じJSON-RPC request IDを維持すると仮定しないでください。`protectMultiRoundTool()` では初回roundだけapplicationの `operationId()` callbackを呼び、resume roundはtrusted original identityを再利用します。

## Lease heartbeat

両wrapperともactively executingなleaseをdefaultでTTLのおよそ3分の1間隔でrenewします。settlement / suspension前にはheartbeatを停止しin-flight renewalを待ちます。

renewal errorだけではbackend側でrenewが適用されたか断定できません。そのため任意のupstream workを自動cancelしません。lease loss時点で即fenceが必要ならprovider-specific cancellation / fencingを実装してください。

## Result / cost classification

### Normal success

`successUnits` 未指定時はfull reservationをchargeします。dynamic costではsafe maximumをreserveしactual unitsを返します。

```ts
successUnits: ({ result }) => result.usageUnits
```

### MCP tool error (`isError: true`)

明示的な `{ isError: true }` resultはsuccessではなくtool errorです。actual costが分かる場合だけ `toolErrorUnits` を指定します。

### Thrown error

thrown errorはdefaultでfull reservationをchargeします。より小さいcostを証明できる場合だけ `errorUnits` を下げます。

```ts
errorUnits: ({ error, lease }) => {
  if (error instanceof ValidationBeforeUpstreamError) return 0;
  return lease.reservedUnits;
}
```

### Classifier failure

classifierがthrow、negative / unsafe / reserved超過値を返した場合もusageを未settledのまま残しません。full reservationをsettleしてから `UsageClassificationError` をthrowします。

## `protectTool()` support boundary

`protectTool()` は意図的にsingle-roundのままです。handlerが `input_required` を返した場合はcurrent reservationを保守的にsettleして `UnsupportedMcpUsageFlowError` を返し、retryを新規callとしてsilent accountingしません。

verified request-stateとserver-side flow-store要件を満たせる場合だけ `protectMultiRoundTool()` を利用してください。

## Settlement failure

settlement failureは `UsageSettlementError` として表面化します。store writeがcommit済みでACKだけ失った可能性があるためblind retryしません。

store-specificなidentical settlement replay / reconciliationはMCP flow retry semanticsとは別責務です。

## Denial / disclosure

admission denialでは `UsageDeniedError` をthrowします。error messageは意図的にgenericな `Usage denied by usage policy` で、詳細 `.reason` はprogrammaticに保持します。

user/model-visible contentへ後からmapされ得るdenial reasonへsecret、private tenant identifier、entitlement internal、balanceを入れないでください。

## Protocol integration test

CIではdirect wrapper testと公式SDK v2 `Client + createMcpHandler` in-process pathの両方をtestします。

- explicit no-input normalization。
- input-schemaのvalidated `(args, ctx)` behavior。
- `isError: true` accounting。
- generic denial message。
- single-round `protectTool()` の明示的 `input_required` reject。
- modern protocol negotiation + `createRequestStateCodec` verificationを通したreal `input_required` retry。
- fresh retry requestを跨いでもquote / reservationが1回だけで、最後にsettleされること。

adapterはpublic `@modelcontextprotocol/server` v2 APIを対象にし、v0.1 CIでは現在v2.0.0をresolveします。coreはMCP SDKをimportしません。
