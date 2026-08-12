# MCPサーバへの組み込み

[English](mcp-integration.md) | [日本語](mcp-integration.ja.md)

`mcp-usage-control-mcp` は、**MCPサーバのtool handlerを包んで、利用枠の予約から確定までを自動化するためのラッパー**です。

MCPクライアントとMCPサーバの間に置くproxyやGatewayではありません。

```text
MCP Client
   ↓
MCP Server
   ↓
protectTool() / protectMultiRoundTool()
   ↓
元のtool handler
```

MCPサーバ側で既存のhandlerを包むだけなので、usage controlのために通信経路を増やす必要はありません。

> 現在packageはまだnpmへ公開していません。[Source / local tarballから使う](using-from-source.ja.md) の手順でcore + MCP adapterをinstallしてください。CIでは `@modelcontextprotocol/server@2.0.0` と組み合わせて検証しています。

## 何を自動化してくれる？

通常のsingle-round toolでは `protectTool()` が次を担当します。

```text
利用枠を予約する
  ↓
handler開始直前に markLiable()
  ↓
実行中はleaseを定期更新
  ↓
元のhandlerを実行
  ↓
成功・tool error・例外を判定
  ↓
実際の消費量をsettle
```

元のhandler側に `reserve()` や `settle()` を毎回手書きする必要がなくなります。

ただし、このadapterは認証やsubscription判定そのものを行いません。`principal` や `operationId` はapplication側で信頼できる情報から渡します。

## 一般的なtoolを包む

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

MCP SDK本来の入力検証は、そのまま元のhandlerより前に動きます。

## 入力がないtool

input schemaを持たないtoolでは `noInput: true` を指定します。

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

これは自動判定にはしていません。MCP SDKの型上は「入力なし」と「空objectを入力に取るtool」をruntime値だけで完全には区別できないためです。

`noInput: true` を指定した場合、adapterがhandlerへ渡す形を正規化します。

## `markLiable()` をhandler開始直前に置く理由

`protectTool()` は、application handlerへ入る直前にleaseを `markLiable()` します。

これは「ここから先は外部APIやDBなどの実コストが発生した可能性がある」とみなす境界です。

汎用adapterには、各providerの本当の課金開始地点までは分かりません。そのため安全側に寄せてhandler開始直前を境界にしています。

もっと遅い地点で `markLiable()` したい場合は、core APIを直接使ってください。

## 長時間toolのheartbeat

handlerの実行中は、leaseが途中で期限切れにならないようadapterが定期的に `renew()` します。

通常はTTLのおよそ3分の1の間隔で更新します。settlementやsuspendへ移る前にはheartbeatを止め、実行中のrenewが終わるのを待ちます。

renewの通信が失敗した場合、「backendでは更新済みだが応答だけ届かなかった」可能性があります。そのためadapterは勝手にupstream処理をcancelしません。

lease loss時に即座に処理を止める必要がある場合は、provider固有のcancellationやfencingを別途実装してください。

## 成功・失敗時に何unit確定する？

### 正常終了

`successUnits` を指定しなければ、予約した全unitを消費したものとして確定します。

実際の消費量が結果から分かる場合はcallbackで返せます。

```ts
successUnits: ({ result }) => result.usageUnits
```

### MCP tool error (`isError: true`)

`{ isError: true }` は正常成功とは分けて扱います。

実際の消費量をapplication側で判断できる場合だけ `toolErrorUnits` を設定してください。

### 例外がthrowされた場合

初期値では予約した全unitを確定します。

外部処理を始める前のvalidation errorなど、コストが発生していないと判断できる場合だけ値を下げます。

```ts
errorUnits: ({ error, lease }) => {
  if (error instanceof ValidationBeforeUpstreamError) return 0;
  return lease.reservedUnits;
}
```

### unit判定callback自体が失敗した場合

callbackがthrowしたり、不正な値を返したりしても、usageを未確定のまま放置しません。

安全側に倒して予約した全unitをsettleしたあと、`UsageClassificationError` を返します。

## `input_required` を使うmulti-round tool

1回のMCP requestだけで完結せず、途中でユーザー入力を求めて別requestで再開するtoolには `protectMultiRoundTool()` を使います。

たとえば:

```text
1回目: 削除を実行しますか？ → input_required
2回目: ユーザーが確認 → 実行継続
```

この2回を別々のtool利用として数えるのではなく、**1つのlogical operationとして同じleaseを引き継ぐ**のが目的です。

### なぜ `protectTool()` ではだめ？

`protectTool()` は1requestで完結するtool専用です。

handlerが `input_required` を返した場合は、そのreservationを安全側にsettleして `UnsupportedMcpUsageFlowError` を返します。

multi-round flowを使う場合だけ `protectMultiRoundTool()` を選んでください。

## Multi-roundの流れ

```text
初回request
  ↓
reserve
  ↓
markLiable
  ↓
handler
  ↓
input_required
  ↓
leaseを延長してserver-sideへ保存
  ↓
signed requestStateをclientへ返す

次のrequest
  ↓
requestStateを検証
  ↓
保存済みflowを1回だけ取り出す
  ↓
同じleaseへ再接続
  ↓
handlerを続行
  ↓
settle
```

重要なのは、**2回目以降で新しくreserveしないこと**です。

## `requestState` は信用しない

`requestState` はclientを経由して戻ってくるため、そのまま信頼できるデータではありません。

MCP SDKの `createRequestStateCodec()` を使って署名・検証し、server-sideに保存した正規のflowへ紐づけます。

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
  key: process.env.REQUEST_STATE_SECRET!,
  ttlSeconds: 600,
});

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

  server.registerTool(
    'confirm-write',
    { description: 'Confirm then write' },
    protectedConfirm,
  );

  return server;
});
```

検証済みのpayloadではなくraw stringが戻ってきた場合、adapterは `McpUsageResumeError` でfail-closeします。

clientから返された文字列をusage accountingの根拠として直接信用しないでください。

## Flow Storeはserver-sideに置く

multi-roundで引き継ぐleaseやtrusted stateはserver-sideに保存します。

`MemoryMcpUsageFlowStore` はtestや1process構成向けです。

複数instanceへrequestが分散する本番環境では、Redis、transactional DB、Durable Objectsなど、複数processで共有できる実装が必要です。

特に `consume(flowId, binding)` は重要で、次をatomicに行う必要があります。

1. 保存済みflowと現在のprincipal / tenant / tool / argsが一致するか確認
2. 一致しなければ正規flowを消費しない
3. 一致した場合だけ、1callerだけがflowを取得できるようconsumeする

これにより、別のprincipalや別toolから正規flowを奪うことを防ぎます。

## Resume tokenは1回しか使えない

resume tokenはone-timeです。

同じtokenで同時に複数requestが再開を試みても、application handlerへ進めるのは1callerだけです。それ以外は `McpUsageResumeError` で失敗します。

principal / tenant / tool / argsが一致しないrequestは、正規flowをconsumeできません。つまり、不正な再開attemptによって本物のflowまで失われないようにしています。

## 放置されたmulti-round flowの扱い

初回handlerへ入る前にすでに `markLiable()` 済みなので、`input_required` のあとclientが戻ってこなかった場合でも「コストが絶対に発生していない」とは扱いません。

suspendされたflowが放置された場合や、resume tokenを取得した直後にprocessが落ちた場合は、lease expiry時に予約した全unitを安全側に保持します。

実行済みかもしれない処理を、timeoutだけで自動refundしないためです。

`maxRounds` でsuspend回数の上限も設定できます。上限を超えた場合は予約した全unitをsettleし、`McpUsageRoundsExceededError` を返します。

## Multi-roundでもexactly-onceまでは保証しない

one-time resume tokenにより、同じtokenから複数handlerが同時再開することは防ぎます。

ただし、application側の任意の副作用までexactly-onceにする仕組みではありません。

たとえば外部APIへのwrite自体は成功したのにresponseだけ失われた場合、そのbusiness resultを自動でcacheして返す機能までは持ちません。

削除、課金、外部writeなど重要な処理では、application側のidempotencyや結果照合も併用してください。

## `operationId` の考え方

同じlogical operationのretryでは、同じ `operationId` を使います。

coreのreplay protectionは次の組み合わせを単位にしています。

```text
(tenantId, principal.id, tool, operationId)
```

single-roundではapplication側がstableなIDを返してください。

multi-roundでは `operationId()` は初回だけ評価され、以後は保存済みflowのIDを引き継ぎます。

各roundの新しいJSON-RPC request IDを、そのままlogical operation IDとして使わないでください。

`operationId` はidempotencyのための識別子であり、認証情報ではありません。

## Principalは信頼できるserver-side情報から作る

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

principal / tenant / planを、callerが送ってきた値から無条件に採用しないでください。

認証済みsessionやserver-side auth contextなど、applicationが信頼できる情報から作ります。

## Settlement失敗時

settlementで通信errorが起きても、「書き込み自体は成功してACKだけ失った」可能性があります。

そのためadapterはblind retryしません。`UsageSettlementError` としてapplicationへ返します。

Store側が持つidempotent settlement replayやreconciliationとは別の責務です。

## 利用上限で拒否された場合

admission denialでは `UsageDeniedError` を返します。

外向けmessageは意図的に一般化した `Usage denied by usage policy` で、詳細reasonはprogrammaticに保持します。

ユーザーやmodelに表示される可能性があるreasonへ、secretや内部tenant ID、private balanceなどを入れないでください。

## Observability

MCP adapter専用の別telemetry方式は持ちません。

`UsageControl` へ `UsageObserver` を設定すれば、coreと同じreserve / denial / settlement / error eventを取得できます。

詳しくは [Observability](observability.ja.md) を参照してください。

## 本番導入前の確認

- `mcp-usage-control-mcp` はproxyではなくserver-side wrapperとして使う
- principal / tenantは信頼できるserver-side情報から作る
- retryではstableな `operationId` を使う
- single-roundは `protectTool()`、multi-roundは `protectMultiRoundTool()` を使い分ける
- multi-roundの `requestState` は必ず検証する
- 複数instance構成ではsharedなFlow Storeを使う
- destructiveな処理ではbusiness側のidempotencyも維持する
- Store errorやsettlement errorを無視して処理成功扱いにしない

## CIで確認しているもの

CIでは、adapter単体だけでなく公式MCP SDK v2の `Client + createMcpHandler` 経路でも確認しています。

主な対象は次のとおりです。

- inputなしtoolの正規化
- input schemaありtoolの `(args, ctx)`
- `{ isError: true }` のusage accounting
- denial message
- `protectTool()` が `input_required` を明示的に拒否すること
- `createRequestStateCodec()` を使った実multi-round retry
- retry requestをまたいでもreserveが1回だけで、最後にsettleされること

core package自体はMCP SDKへ依存しません。
