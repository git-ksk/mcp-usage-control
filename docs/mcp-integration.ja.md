# MCP integration — v0.1

[English](mcp-integration.md) | [日本語](mcp-integration.ja.md)

`mcp-usage-control-mcp` はcore lifecycleを `@modelcontextprotocol/server` v2の **single-round** tool handlerへ接続するadapterです。

```console
npm install mcp-usage-control-mcp @modelcontextprotocol/server
```

adapter自体はauthenticationやsubscription判定を行いません。application側でtrustedな `Principal` とlogical `operationId` を導出します。

## Protected toolを登録

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

## Execution lifecycle

admission後の順序:

```text
reserve -> markLiable -> heartbeat -> handler -> stop heartbeat -> classify -> settle
```

liability boundaryはapplication handler entry直前です。generic adapterはprovider-specificな実コスト発生点を知らないため保守的な境界を採用します。より遅いprovider-awareな `markLiable()` が必要ならcore lifecycleを直接利用してください。

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

`operationId` は同じlogical executionのretryではstable、intentional new executionではdifferentである必要があります。non-secretなidempotency identityでありauthorization proofではありません。

`ctx.mcpReq.id` はrequest-scoped用途やtestには使えますが、logical retry間でclient/hostが同じJSON-RPC request IDを維持すると仮定しないでください。retry-stable accountingが必要ならapplication独自のstable invocation identityを用意します。

## Lease heartbeat

`protectTool()` はdefaultでlease TTLのおよそ3分の1間隔でactive leaseをrenewします。settlement前にはheartbeatを停止しin-flight renewalを待ちます。

renewal errorだけではRedis側でrenewが適用されたか断定できません。そのため任意のupstream workを自動cancelしません。lease loss時点で即fenceが必要ならprovider-specific cancellation / fencingを実装してください。

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

## `input_required` support boundary

MCP v2 `resultType: 'input_required'` はmulti-round flowです。clientがinputを集め、fresh requestでtool executionへ再入場します。正しいaccountingにはreservation suspend/resume、abandonment recovery、cross-round replay identity、carried stateのtrust ruleが必要です。

**v0.1の `protectTool()` はこのflowを未対応とします。** wrapped handlerが `input_required` を返した場合はcurrent reservationを保守的にsettleし `UnsupportedMcpUsageFlowError` を返します。Issue #14が実装されるまではproductionの `input_required` toolをwrapしないでください。

## Settlement failure

settlement failureは `UsageSettlementError` として表面化します。store writeがcommit済みでACKだけ失った可能性があるためblind retryしません。

`mcp-usage-control-redis` はidentical settlement replayをidempotentにし、conflicting replayをrejectします。application-level reconciliationは別責務です。

## Denial / disclosure

admission denialでは `UsageDeniedError` をthrowします。error messageは意図的にgenericな `Usage denied by usage policy` で、詳細 `.reason` はprogrammaticに保持します。

user/model-visible contentへ後からmapされ得るdenial reasonへsecret、private tenant identifier、entitlement internal、balanceを入れないでください。

## Protocol integration test

CIではdirect wrapper testと公式SDK v2 `Client + createMcpHandler` in-process pathの両方をtestします。

- explicit no-input normalization。
- input-schemaのvalidated `(args, ctx)` behavior。
- `isError: true` accounting。
- generic denial message。
- unsupported `input_required` behavior。

adapterはpublic `@modelcontextprotocol/server` v2 APIを対象にし、v0.1 CIでは現在v2.0.0をresolveします。coreはMCP SDKをimportしません。
