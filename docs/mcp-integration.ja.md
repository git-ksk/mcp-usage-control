# MCP integration

[English](mcp-integration.md) | [日本語](mcp-integration.ja.md)

`@mcp-usage-control/mcp` は、coreのusage-control lifecycleを `@modelcontextprotocol/server` v2 の **single-round** tool handlerへ接続するadapterです。

このadapter自体はauthenticationを行わず、subscription entitlementも決定しません。application側で信頼できる `Principal` と、idempotencyに使う安定した `operationId` を導出してください。

## Wrapperを置く位置

MCP TypeScript SDK v2では `registerTool(name, config, handler)` でtoolを登録します。`protectTool()` はそのhandlerをwrapします。

```ts
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
      principal: async ctx => getPrincipalFromTrustedAuthContext(ctx),
      operationId: async (args, ctx) => getStableInvocationId(args, ctx),
    },
    async ({ query }) => ({
      content: [{ type: 'text', text: await searchCatalog(query) }],
    }),
  ),
);
```

SDK本来のargument validationはwrapped handlerが実行される前にそのまま動作します。

### input schemaがないtool

SDK v2のcallback invocationには2つの形があります。input schemaありのtoolは `(args, ctx)`、input schemaなしのtoolは `(ctx)` で呼ばれます。`protectTool()` は両方を受け付け、no-input形式をnormalizationして、policy / hook / wrapped application handlerには `args === undefined` と正しい `ServerContext` を渡します。

このnormalizationはprotocol integration testで固定しています。`protectTool()` 利用時にfirst argumentから独自にcontextを推測する必要はありません。

## Execution lifecycle

admission後は次の順で処理します。

```text
reserve -> markLiable -> start heartbeat -> handler -> stop heartbeat -> classify -> settle
```

`markLiable()` はhandlerへ入る直前に実行します。この時点以降のlease expiryは保守的に扱われ、processがsettlement前に消失した場合もfull reservationを未使用としてrefundせず、消費済みとして維持します。

generic wrapperはprovider-specificな実コスト発生点を知れないため、handler entryをcost-liability boundaryにします。より遅く正確な境界が必要な場合はcore lifecycleを直接使うかprovider-specific adapterを実装してください。

## Principalの導出

principalはaccounting上のidentityであり、authentication mechanismではありません。

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

serverがすでに信頼しているauthentication stateから導出してください。caller suppliedのprincipal / plan / tenant identifierをauthorizationなしで信用してはいけません。

## Operation ID

`operationId` は1つのlogical invocationに対するidempotency keyです。同一logical executionのretryではstable、意図的な別実行ではdifferent、non-secret、かつtrusted request/dispatch stateから導出するのが望ましいです。

MCP JSON-RPC request ID (`ctx.mcpReq.id`) はtestやrequest-scopedな用途には使えますが、host/client retryを跨いだlogical idempotency keyとしてstableだと仮定してはいけません。retry-stable accountingが必要なapplicationは独自のstable invocation identityを用意してください。

## Lease heartbeat

既定では `protectTool()` がhandler実行中、lease TTLのおよそ3分の1間隔でactive reservationをrenewします。settlement前にはheartbeatを停止し、in-flight renewal完了を待ちます。

renewal failureだけではlease lossが確定しないため、generic wrapperは任意のupstream workを自動cancelしません。execution-started leaseはcost-liableなので、実際にexpireした場合はrefundではなく保守的にchargeされます。lease ownershipを失った瞬間に処理停止が必要ならprovider-specific fencing / cancellationを実装してください。

## Successful result

`successUnits` 未指定時はnormal successでfull reservationをsettleします。dynamic-cost toolではpolicy側で安全な最大値をreserveし、実行後にactual unitsを返します。

```ts
successUnits: ({ result }) => result.usageUnits
```

現在のcontractでは `actualUnits <= reservedUnits` が必要です。

`successUnits` がthrowしたり、negative / unsafe / reserved超過値を返した場合でもleaseをpendingのまま放置しません。full reservationをsettleした後、`UsageClassificationError` を表面化します。

## MCP tool error (`isError: true`)

MCP tool handlerは `isError: true` を持つ通常resultを返すことがあります。これはsuccessとして扱いません。

known costがある場合は `toolErrorUnits` を利用できます。

```ts
toolErrorUnits: ({ result, lease }) => {
  if (isKnownZeroCostMiss(result)) return 0;
  return lease.reservedUnits;
}
```

未指定時はfull reservationをchargeします。classifierが失敗した場合もfull reservationをsettleしてから `UsageClassificationError` を表面化します。

## Thrown error

throwされた未分類errorも既定でfull reservationをchargeします。metered resource未消費を証明できる場合、またはexact partial costを把握できる場合だけ `errorUnits` を小さくしてください。

```ts
errorUnits: ({ error, lease }) => {
  if (error instanceof ValidationBeforeUpstreamError) return 0;
  return lease.reservedUnits;
}
```

upstream operationが実行されていないことを証明できないnetwork errorを広く0-cost扱いするのは避けてください。

## `input_required` はまだ未対応

MCP v2では `resultType: 'input_required'` を返し、clientが入力を収集してfresh requestでhandlerへ再入場できます。これを正しくquota accountingするにはround間のreservation suspend/resume semanticsが必要です。

そのため現在のpre-alpha `protectTool()` は `input_required` を意図的にrejectします。wrapped handlerが返した場合、current reservationを保守的にsettleし、`UnsupportedMcpUsageFlowError` を表面化します。roundごとにsilent課金したり、同じoperation IDでduplicate deadlockするより安全です。

explicit supportが入るまではproductionのmulti-round `input_required` toolへ `protectTool()` を適用しないでください。この制約はv0.1向けに追跡します。

## Settlement failure

settlement errorは `UsageSettlementError` として表面化します。datastoreはwriteを反映した後、ACKだけ失う可能性があるためadapterはsettlementを盲目的にretryしません。

Redis adapterでは同一settlement replayがidempotentですが、recovery / reconciliation policy自体はapplicationの責務です。

## Denialとinformation disclosure

admission denialでは `UsageDeniedError` をthrowします。human-readable messageは意図的にgenericな `Usage denied by usage policy` とし、詳細な `reason` はprogrammatic propertyとして保持しますがthrow messageには埋め込みません。

policy reasonは明示的にsafe mappingするまではinternal dataとして扱ってください。tenant ID、内部budget key、balance、entitlement detailをdenial reason経由でuser/modelへ漏らさないでください。

## Protocol integration test

repositoryではdirect wrapper testに加え、公式SDK v2の `Client + createMcpHandler` in-process pathでもtestします。現在次を固定しています。

- SDKの両callback shape（no-input-schema `(ctx)` normalizationを含む）。
- `isError: true` の保持とtool-error accounting。
- internal reasonを露出しないgeneric denial message。
- unsupported `input_required` flowの明示reject。

## MCP SDK compatibility

adapterはpublic `@modelcontextprotocol/server` v2 APIを対象にし、現在v2.0.0に対してbuild/testしています。core packageはMCP SDKをimportしないため、protocol / SDK changeをadapterへ隔離できます。