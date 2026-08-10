# MCP integration

[English](mcp-integration.md) | [日本語](mcp-integration.ja.md)

`@mcp-usage-control/mcp` は、coreのusage-control lifecycleを `@modelcontextprotocol/server` v2 のtool handlerへ接続するadapterです。

このadapter自体はauthenticationを行わず、subscription entitlementも決定しません。application側で信頼できる `Principal` と、idempotencyに使う安定した `operationId` を導出してください。

## Wrapperを置く位置

MCP TypeScript SDK v2では `registerTool(name, config, handler)` でtoolを登録します。`protectTool()` はそのhandlerをwrapします。

```ts
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { protectTool } from '@mcp-usage-control/mcp';

const server = new McpServer({ name: 'example', version: '1.0.0' });

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
    async ({ query }) => {
      return {
        content: [{ type: 'text', text: await searchCatalog(query) }],
      };
    },
  ),
);
```

SDK本来のargument validationはそのまま動作し、usage admissionはwrapされたhandlerが呼ばれた時点で実行されます。

## Principalの導出

principalはaccounting上のidentityであり、authentication mechanismではありません。

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

serverがすでに信頼しているauthentication stateから導出してください。callerが送ってきた `principal.id`、plan、tenant IDをauthorization確認なしでそのまま信用してはいけません。

現在のcoreではduplicate operation IDを `principal.id` 単位でscopeします。shared tenant budgetを利用する場合は、policyと今後のmulti-budget設計でtenant isolationを維持してください。

## Operation ID

`operationId` は1つのlogical tool executionに対するidempotency keyです。

適切なoperation IDは次の性質を持ちます。

- 同一logical invocationのtransport/client retryでは同じ値になる。
- 同じargumentsでも、意図的に別実行した場合は異なる値になる。
- model-provided argumentsだけではなく、信頼できるrequest/dispatch stateから導出する。
- secretとして扱う必要のない値にする。

retryがhandlerへ届くたびに新しいrandom IDを作るとduplicate protectionが無効になります。またoperation IDをauthentication / authorization credentialとして扱わないでください。

## Lease heartbeat

既定では `protectTool()` がhandler実行中、lease TTLのおよそ3分の1間隔でactive reservationをrenewします。settlement前にはheartbeatを停止し、実行中のrenew完了を待つため、通常のrenew/settle raceを避けます。

```ts
protectTool(
  {
    control,
    tool: 'long_job',
    principal,
    operationId,
    leaseHeartbeat: true,
  },
  handler,
);
```

`leaseHeartbeat: false` は、application側で同等のrenew/fencing mechanismを実装する場合だけ利用してください。

### Distributed leaseの重要な制約

built-in heartbeatは便利なrenew mechanismですが、provider-specific fencingではありません。個々のrenew errorを理由に、任意のupstream operationを強制停止することはしません。そのため、Redis/network partitionが十分長く続くと、leaseが失効してもupstream toolが動き続ける可能性があります。

lease ownershipを失った瞬間にmetered resourceを停止・fenceする必要がある場合は、applicationまたはprovider adapter側で実装してください。詳しくは [Architecture](architecture.ja.md) を参照してください。

## Success settlement

`successUnits` を指定しない場合、成功時はreserved amount全体をsettleします。dynamic cost toolではpolicyで安全な最大値をreserveし、実行後にactual amountを返します。

```ts
protectTool(
  {
    control,
    tool: 'generate_report',
    principal,
    operationId,
    successUnits: ({ result }) => result.usageUnits,
  },
  handler,
);
```

現在のcontractでは `actualUnits <= reservedUnits` が必要です。

## Error settlement

未分類のtool errorは保守的にfull reservationを課金します。upstream cost発生後に意図的にfailureを起こしてquotaを回避するパターンを防ぐためです。

metered resourceが消費されていないことを証明できる場合、またはpartial costを正確に把握できる場合だけ `errorUnits` を小さくしてください。

```ts
errorUnits: ({ error, lease }) => {
  if (error instanceof ValidationBeforeUpstreamError) return 0;
  return lease.reservedUnits;
}
```

upstream operationが実行されていないことを証明できないnetwork errorを、広く0-cost扱いするのは避けてください。

## Settlement failure

settlement errorは `UsageSettlementError` として表面化します。datastoreはwriteを反映した後、ACKだけ失う可能性があるため、adapterはsettlementを盲目的にretryしません。

```ts
try {
  await protectedHandler(args, ctx);
} catch (error) {
  if (error instanceof UsageSettlementError) {
    // datastore stateが曖昧な可能性があります。operation IDを維持し、
    // idempotentなrecovery pathでのみreconcile/retryしてください。
  }
  throw error;
}
```

Redis adapterでは同一settlementのreplayがidempotentになるよう設計していますが、recovery policy自体はapplicationの責務です。

## Denial

admissionが拒否された場合、adapterはwrapped handlerを実行する前に `UsageDeniedError` をthrowします。server/client UXに合わせて適切なMCP result/errorへ変換してください。

意図的な仕様でない限り、無関係なtenant balanceや内部budget identifierをuser-facing messageへ含めないでください。

## MCP SDK compatibility

adapterはpublicな `@modelcontextprotocol/server` v2 APIを対象にし、public `ServerContext` typeを利用します。core packageはMCP SDKをimportしないため、protocol / SDKの変更をadapterへ隔離できます。

現在のrepositoryでは `@modelcontextprotocol/server` v2.0.0に対してTypeScript buildを確認しています。peer dependencyを更新する場合はfull CIを実行し、SDK migration noteも確認してください。