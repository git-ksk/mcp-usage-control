# mcp-usage-control-mcp

MCP TypeScript SDK v2 adapter for `mcp-usage-control`.

> **Current distribution status:** this package is not published to npm yet. Use the repository checkout or locally packed `mcp-usage-control` + `mcp-usage-control-mcp` tarballs. See [Use from source / local tarballs](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.md) / [日本語](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.ja.md).

## English

`protectTool()` wraps **single-round** `@modelcontextprotocol/server` v2 tool handlers with admission, cost-liable activation, lease heartbeat, MCP-aware result classification, and explicit settlement.

`protectMultiRoundTool()` is the opt-in wrapper for MCP v2 `input_required` flows. It keeps one logical usage reservation across fresh MCP retry requests instead of reserving again for every round.

For a tool with no input schema, set `noInput: true`. For input-schema tools, omit it. The adapter normalizes the SDK no-input callback/runtime shape without guessing whether `{}` is real input.

It distinguishes normal success, `{ isError: true }`, and thrown errors. Invalid/throwing cost classifiers cause the full reservation to be settled before `UsageClassificationError` is surfaced. Ambiguous settlement failures are surfaced as `UsageSettlementError` and are not blindly retried.

### Returning a bounded remaining value

Successful core admission exposes the authoritative store-produced `remainingByBudget`. The MCP wrappers intentionally do not inject balances into handler results. If a tool must return a bounded remaining value to its consumer, use the core lifecycle directly at that integration point and select only the application-approved budget value:

```ts
const admission = await control.reserve(request);
if (!admission.allowed) throw new UsageDeniedError(admission.reason);

const remaining = admission.remainingByBudget.find(
  balance => balance.key === expectedBudgetKey,
)?.remaining;

const lease = admission.lease;
await lease.markLiable();
const value = await runTool();
await lease.settle(1, 'success');

return {
  content: [
    {
      type: 'text',
      text: JSON.stringify({ value, ...(remaining === undefined ? {} : { remaining }) }),
    },
  ],
};
```

Do not recompute the balance from configured limits in the MCP layer; the usage store is authoritative. Budget keys can contain application-sensitive or high-cardinality identity, so do not expose the key itself to the model/client or promote it to metric labels by default. Prefer a single numeric value selected by application policy.

### Multi-round trust boundary

MCP `requestState` round-trips through the client and is untrusted. `protectMultiRoundTool()` therefore does **not** put the usage lease in client state and does not trust a client-supplied flow identifier by itself.

- configure the MCP server's `requestState.verify` hook, for example with the official SDK `createRequestStateCodec()`;
- pass the matching mint function through `requestState.mint`;
- keep `McpUsageFlowRecord` server-side;
- use a `McpUsageFlowStore` whose `consume()` atomically compares the principal/tool/args binding and consumes the flow exactly once;
- use `MemoryMcpUsageFlowStore` only for tests or a single-process server, and instantiate it outside a per-request `createMcpHandler` factory;
- distributed servers must provide a durable/shared implementation with the same atomic compare-and-consume contract.

The wrapper owns the wire `requestState`. A handler-authored `requestState` is retained only in trusted server-side flow storage and is supplied on the next round as `flow.applicationRequestState`.

`suspendTtlMs` is explicit. The lease is already cost-liable before the application handler runs; if a suspended/claimed flow is abandoned, expiry conservatively retains the full reservation rather than refunding a possibly executed operation.

Resume tokens are one-time. A concurrent or repeated resume after one caller has claimed the token fails closed instead of re-running the handler. This prevents duplicate execution/reservation, but it is not a general exactly-once side-effect or response-replay mechanism; applications that require replay of a completed business result need their own business-idempotency/result store.

- [Current source/tarball usage](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.md)
- [MCP integration](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/mcp-integration.md)
- [API reference](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/api-reference.md)
- [Architecture](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/architecture.md)

The application remains responsible for trusted principal/tenant derivation, authentication/authorization, retry-stable logical operation IDs, durable flow storage when horizontally scaled, and provider-specific fencing after lease loss.

## 日本語

`protectTool()` は `@modelcontextprotocol/server` v2の **single-round** tool handlerをusage admission、cost-liable activation、lease heartbeat、MCP-aware result classification、explicit settlementでwrapします。

`protectMultiRoundTool()` はMCP v2 `input_required` 向けのopt-in wrapperです。fresh MCP retry requestごとに再reserveせず、1つのlogical usage reservationをround間で維持します。

input schemaがないtoolでは `noInput: true` を指定し、input schemaありでは省略します。SDKのno-input callback / runtime shapeをnormalizeしますが、`{}` がreal inputかどうかを推測しません。

normal success、`{ isError: true }`、thrown errorを区別します。classifierがthrow / invalid unitsを返した場合はfull reservationをsettleしてから `UsageClassificationError` を表面化します。ambiguous settlement failureは `UsageSettlementError` として表面化しblind retryしません。

### boundedなremaining値を返す

coreのadmission成功結果には、authoritative storeが算出した `remainingByBudget` が含まれます。MCP wrapperはbalanceをhandler resultへ自動注入しません。tool consumerへboundedなremaining値を返したい場合は、そのintegration pointだけcore lifecycleを直接使い、applicationが許可したbudgetの値だけを選択します。

```ts
const admission = await control.reserve(request);
if (!admission.allowed) throw new UsageDeniedError(admission.reason);

const remaining = admission.remainingByBudget.find(
  balance => balance.key === expectedBudgetKey,
)?.remaining;

const lease = admission.lease;
await lease.markLiable();
const value = await runTool();
await lease.settle(1, 'success');

return {
  content: [
    {
      type: 'text',
      text: JSON.stringify({ value, ...(remaining === undefined ? {} : { remaining }) }),
    },
  ],
};
```

MCP layerでconfigured limitからbalanceを再計算しないでください。usage storeがsource of truthです。budget keyにはapplication-sensitive / high-cardinalityなidentityが含まれ得るため、key自体をmodel/clientへ出したりmetric labelへ自動昇格したりしません。application policyで選択した単一のnumeric valueだけを返す形を推奨します。

### Multi-roundのtrust boundary

MCP `requestState` はclientを往復するためuntrustedです。`protectMultiRoundTool()` はusage leaseをclient stateへ入れず、client supplied flow IDだけをaccounting authorityとして信用しません。

- MCP server側で `requestState.verify` を設定します。公式SDKの `createRequestStateCodec()` を利用できます。
- 対応するmint関数を `requestState.mint` へ渡します。
- `McpUsageFlowRecord` はserver-sideに保持します。
- `McpUsageFlowStore.consume()` はprincipal / tool / args bindingを比較し、matchしたflowだけをatomicにone-time consumeする必要があります。
- `MemoryMcpUsageFlowStore` はtestまたはsingle-process server専用です。per-request `createMcpHandler` factoryの外側で生成してください。
- horizontal scaleするserverでは同じatomic compare-and-consume contractを満たすshared/durable storeを用意してください。

wire上の `requestState` はwrapperが所有します。application handlerが返した `requestState` はtrusted server-side flow storageだけに保持し、次roundでは `flow.applicationRequestState` として渡します。

`suspendTtlMs` は明示必須です。application handlerへ入る前にleaseはすでにcost-liableなので、suspend / claim後にflowがabandonされた場合はexpiryでfull reservationを保守的に維持し、実行済みかもしれない処理をrefundしません。

resume tokenはone-timeです。同じtokenのconcurrent/repeated resumeは1 callerがclaimした後fail-closeし、handlerを再実行しません。これはduplicate execution / duplicate reservationを防ぎますが、汎用的なexactly-once side effectやcompleted response replayを保証するものではありません。business resultのreplayが必要なapplicationは既存のbusiness idempotency / result storeを併用してください。

- [現在のsource / tarball利用手順](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/using-from-source.ja.md)
- [MCP integration](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/mcp-integration.ja.md)
- [API reference](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/api-reference.ja.md)
- [Architecture](https://github.com/git-ksk/mcp-usage-control/blob/main/docs/architecture.ja.md)

trustedなprincipal / tenant derivation、authentication / authorization、retry-stable logical operation ID、horizontal scale時のdurable flow storage、lease loss後のprovider-specific fencingはapplication側の責務です。

## Vector workloads (v0.7)

`protectTool()` remains the bounded scalar convenience wrapper. Heterogeneous request/token/compute workloads should use the explicit `VectorUsageControl` / `VectorUsageLease` lifecycle from `mcp-usage-control` so every required dimension is reserved, grown, and settled atomically before metered work proceeds.
