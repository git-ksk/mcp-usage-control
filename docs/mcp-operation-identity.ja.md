# MCP single-round read の logical operation identity

[English](mcp-operation-identity.md) | [日本語](mcp-operation-identity.ja.md)

このdocumentは、application-level idempotency keyを元々持たないsingle-round read-only MCP toolについて、v1.1のdesign decisionを記録します。

## Decision

`mcp-usage-control-mcp` は、MCP / JSON-RPC request ID、session ID、その他weakなtransport identifierからlogical accounting identityを生成するhelperを追加しません。

read-only tool向けのweakなbounded dedup cacheも追加せず、`operationId` がretry-stableだとlibrary側で断定するdiagnostic eventも追加しません。adapterは `operationId()` が返したstringの由来を判定できないためです。

canonical ruleは次のままです。

- applicationがretry-stableなlogical-operation keyを持つなら、そのkeyを `operationId()` から返す;
- 持たないなら、受信したtool dispatchごとに新しいlogical operationとしてserver-sideでfresh IDを生成する;
- `ctx.mcpReq.id` をauthentication / authorizationや「同じlogical operation」の十分な証拠として扱わない。

これは意図的にconservativeな判断です。強いapplication signalが無い場合、fresh transport requestが「前のuser actionのretry」なのか「意図的な2回目のread」なのかlibraryには区別できず、推測するとfalse deduplicationを起こせます。

## request-ID helperを追加しない理由

MCP / JSON-RPC request IDはtransport requestを識別するもので、business intentを識別するものではありません。retryで別request IDになることがあり、response完了後に同じrequest IDが再利用されることもあります。session IDを組み合わせてもdurableなlogical-operation identityにはならず、false duplicateとretry取りこぼしの両方が起こり得ます。

1つのreceived request lifetimeだけにscopeしたhelperも問題を解決しません。`protectTool()` はそのdispatch内で `operationId()` を既に1回だけ評価しています。難しいのは、後から来たfresh requestが前のrequestと同じlogical actionかどうか分からない点です。

## weakなread-only dedup modeを追加しない理由

短時間のdedup windowをargs、request ID、session/request pairなどで作ると、意図的な2回のreadを1回へ潰す場合があります。read-onlyでもprovider costを発生させたりquotaを消費したり、新しいstateを観測したり、意図的に再実行されることがあります。

そのためusage layerはweak identifierからexactly-once / once-per-user-action semanticsを作りません。

## Canonical option A: dispatchごとにfresh ID

client/product側にretry-stableなlogical keyがない場合はこちらを使います。

```ts
import { randomUUID } from 'node:crypto';
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
      operationId: () => randomUUID(),
    },
    async ({ query }) => ({
      content: [{ type: 'text', text: await searchCatalog(query) }],
    }),
  ),
);
```

この方式の性質:

- received dispatchごとに別accounting operationになる;
- intentional repeated readをweak heuristicで誤ってcollapseしない;
- transport/client retryがfresh dispatchとして届くと、quotaを再消費する可能性がある;
- fresh UUIDはidempotency identityでありauthorization proofではない。

より強いsignalがないordinary readでは、これをcanonical conservative choiceとします。

## Canonical option B: application-provided retry-stable key

productがretryを跨ぐ1 logical user actionを定義できる場合だけ使います。例として、userがsearchを開始した時にclientがopaque action IDを1つ作り、そのactionのretry時だけ同じIDを再利用できます。

```ts
const SearchInput = z.object({
  query: z.string(),
  usageOperationId: z.string().min(1).max(128),
});

server.registerTool(
  'search',
  {
    description: 'Search the catalog',
    inputSchema: SearchInput,
  },
  protectTool(
    {
      control,
      tool: 'search',
      principal: ctx => getPrincipalFromTrustedAuthContext(ctx),
      operationId: args => validateApplicationOperationId(args.usageOperationId),
    },
    async ({ query }) => ({
      content: [{ type: 'text', text: await searchCatalog(query) }],
    }),
  ),
);
```

applicationはkey lifecycleを明示します。

- intentional new user actionごとにnew keyを作る;
- 同じlogical actionのretry時だけreuseする;
- use前にvalidate / boundする;
- authorization / tenant identityをこの値から導出しない;
- weakなshared keyで異なるuserをまとめない。

core replay scopeは次のままです。

```text
(tenantId, principal.id, tool, operationId)
```

principal/tool isolationは効きますが、それによってuntrusted client tokenがauthentication credentialになるわけではありません。

## retry-stable accountingがすること / しないこと

stable `operationId` は、replay state保持中にretryが2個目のindependent usage reservationを作ることを防ぎます。business resultをcache / replayする機能ではありません。

最初のexecutionが完了したのにresponseだけ失われた場合、同じlogical operation IDの後続requestはhandlerを再実行せずduplicateとしてrejectされることがあります。成功responseのrecoveryが必要なら、application側で別のbusiness-result / idempotency layerを持ってください。

## Transport request identity と logical operation identity

| Identity | 意味 | accountingでの安全な利用 |
| --- | --- | --- |
| `ctx.mcpReq.id` | 1つのMCP / JSON-RPC transport request | diagnostics / test用途。retry-stable logical identityとしては不十分 |
| session + request ID | transport-local pair | 1 logical user actionの証拠にはならない |
| fresh server UUID | 1 received dispatch | conservative fallbackとして安全。transport retryを二重meterする可能性あり |
| application logical action ID | retryを跨ぐproduct-defined action | lifecycleを明示しvalidateできる場合のpreferred choice |

## Multi-round tool

`protectMultiRoundTool()` は別です。initial round後はverified server-side flow stateで元のtrusted usage leaseとlogical operation IDを引き継ぐため、`input_required` resume時のfresh MCP request IDからnew reservationを作りません。

このmulti-round resume mechanismをarbitrary single-round deduplicationへ流用しないでください。

## Observability

「unstable operation ID」用の新observer eventは追加しません。adapterが見えるのはapplicationが返した最終stringだけで、その生成方法を正しく判定できないためです。

fresh-per-dispatchを採用するapplicationは、そのintegration policyを自分のbounded static configuration / telemetryとして記録できます。raw operation ID、request ID、principal、tool argsをhigh-cardinality metrics labelへ出さないでください。

## Summary

trustworthyなretry-stable logical keyがない場合は、**推測するよりdispatchごとにfresh IDを使う方が安全**です。retryを跨いで1回だけmeterしたいproductはapplication-level logical action IDを明示導入し、そのlifecycleを定義してください。JSON-RPC request identityから導出しないでください。
