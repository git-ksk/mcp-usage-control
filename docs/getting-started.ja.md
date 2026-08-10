# Getting started

[English](getting-started.md) | [日本語](getting-started.ja.md)

## Requirements

- Node.js 20以上
- `mcp-usage-control-redis` 利用時はRedis 7
- `mcp-usage-control-mcp` 利用時はMCP TypeScript SDK v2

## Install

Coreのみ:

```console
npm install mcp-usage-control
```

MCP adapter:

```console
npm install mcp-usage-control-mcp @modelcontextprotocol/server
```

Redis store:

```console
npm install mcp-usage-control-redis redis
```

repository sourceから確認する場合:

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

CIでは同じlockfileを使ってNode.js 20 / 22、実Redis 7、公式MCP SDK v2 client/handler integration pathまでtestします。

## Mental model

```text
principal -> policy -> quote -> atomic reserve -> mark liable -> execute -> settle
                                 ^                          |
                                 |----------- renew --------|
```

policyがeligibility、最大units、適用budgetを決め、storeが参加する全budgetをatomicに比較・reserveします。

reservationは最初 `pending` です。metered execution開始直前に `markLiable()` を呼びます。pending expiryはcapacityを解放しますが、cost-liable expiryはfull reservationを維持し、execution開始後のworker/process crashがrefundになることを防ぎます。

## Policyを定義

```ts
import { MemoryUsageStore, UsageControl, type UsagePolicy } from 'mcp-usage-control';

const policy: UsagePolicy = {
  quote(request) {
    const tenantId = request.principal.tenantId ?? 'personal';
    return {
      decision: 'allow',
      units: request.tool === 'full_export' ? 5 : 1,
      budgets: [
        { key: `day:user:${request.principal.id}:2026-08-10`, limit: 20 },
        { key: `month:user:${request.principal.id}:2026-08`, limit: 100 },
        { key: `month:tenant:${tenantId}:2026-08`, limit: 2_000 },
      ],
    };
  },
};

const control = new UsageControl(new MemoryUsageStore(), policy);
```

列挙したbudgetは全部reserveされるか、どれもreserveされないかのall-or-nothingです。budget keyはapplication側定義です。calendar windowでは明示的にwindow-qualified keyを使い、runtimeはreset dateを推測しません。

1 budgetのみなら `budgets` の代わりに `budget` も利用できます。

## Coreを直接reserve / settle

```ts
const admission = await control.reserve({
  operationId: 'logical-request-123',
  principal: { id: 'user-42', tenantId: 'org-7', plan: 'free' },
  tool: 'search',
  args: { query: 'example' },
});

if (!admission.allowed) {
  // quota_exceededではlimitingBudgetKey / remainingを含む場合があります。
  throw new Error(`usage denied: ${admission.reason}`);
}

await admission.lease.markLiable();
try {
  const result = await performMeteredWork();
  await admission.lease.settle(1, 'success');
  return result;
} catch (error) {
  await admission.lease.settle(admission.lease.reservedUnits, 'error');
  throw error;
}
```

metered resourceを消費していないことを証明できる場合のみzero settlementを使います。in-memory storeはtest / local development向けで、distributed production enforcement向けではありません。

## Idempotency

同じlogical invocationをretryするときは同じ `operationId` を使います。replay protectionのscopeは次です。

```text
(tenantId, principal.id, tool, operationId)
```

`operationId` はcredentialではありません。principal / tenantはtrustedなserver-side authentication contextから取得してください。

settled operationはdefault 24時間replay protectionされます。retry horizonが異なる場合はMemory / Redis storeの `idempotencyTtlMs` を変更します。

## Production Redis store

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from 'mcp-usage-control-redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const control = new UsageControl(new RedisUsageStore(redis), policy);
```

Redisはmulti-budget admissionとlifecycle変更を1つのtransaction domain内でatomicに行います。lease / tombstone時刻はRedis server `TIME` から取得します。HA / persistence、cleanup、Redis Cluster、ACK ambiguityは [Redis adapter](redis.ja.md) を確認してください。

## MCP tool handler

`@modelcontextprotocol/server` v2の **single-round** toolでは `protectTool()` を使います。

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

input schemaがないMCP toolでは `noInput: true` を指定します。

`protectTool()` はreserve、cost-liable化、handler実行中のrenew、MCP success/tool error/exception classification、settlementまで行います。classifier failureではfull reservationをsettleしてからclassification errorを表面化します。

### Multi-round MCP tool

v0.1の `protectTool()` は `resultType: 'input_required'` を意図的にrejectします。正しいmulti-round accountingにはrequest間のsuspend/resume contractが必要です。Issue #14が実装されるまではproductionの `input_required` toolをwrapしないでください。

## Production checklist

- principal / tenant IDはtrustedなserver-side contextから導出する。
- retryではstableなlogical operation IDを使う。
- daily / monthly / tenantなど適用される全budgetを1 quoteで返す。
- tool durationに合うreservation TTL / heartbeatを設定する。
- zero-cost failureはcost未発生を証明できる場合だけ分類する。
- 許容accounting lossに合わせてRedis persistence / HAを構成する。
- Redis atomicityをdurable financial ledgerと同一視しない。
- v0.1 MCP wrapperを `input_required` flowへ使わない。

詳しくは [Architecture](architecture.ja.md)、[API reference](api-reference.ja.md)、[Redis adapter](redis.ja.md)、[Security policy](../SECURITY.ja.md) を参照してください。
