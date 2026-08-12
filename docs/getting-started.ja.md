# Getting started

[English](getting-started.md) | [日本語](getting-started.ja.md)

このページは、`mcp-usage-control` を初めて見る人向けの最短ガイドです。

## まず何をするライブラリ？

MCP toolを実行する**前**に利用枠を確保し、実行後に実際の消費量を確定するライブラリです。

たとえば「残り1回」の状態で2 requestが同時に来た場合、単純な `check -> execute -> increment` だと両方が実行を開始できてしまうことがあります。

`mcp-usage-control` は先にreserveするため、同じquotaを超えて同時実行されることを防ぎます。

```text
request
  -> policyで「何unit必要か」を決める
  -> storeでquotaをatomicにreserve
  -> tool実行開始直前にcost-liable化
  -> toolを実行
  -> 実際の消費量でsettle
```

payment、請求書、subscription管理そのものを行うライブラリではありません。**tool executionとusage accountingの境界を安全にする**ことが役割です。

## 3つだけ覚える

- **Policy** — このcallを許可するか、何unit使うか、どのbudgetへ課金するかを決める。
- **Store** — budgetとreservationをatomicに更新する。Memory / Redis / Cloudflare / Firestoreから選ぶ。
- **Lease** — reserve後の1回の実行枠。`markLiable()`、`renew()`、`settle()` を持つ。

## どのpackageを使う？

| Package | 用途 |
| --- | --- |
| `mcp-usage-control` | core API。Memory storeも含む。まず試すならこれ |
| `mcp-usage-control-mcp` | MCP SDK v2のtool handlerをwrapしたい |
| `mcp-usage-control-redis` | Redisで高頻度・shared quotaを扱いたい |
| `mcp-usage-control-cloudflare` | Cloudflare Durable Objects上で動かしたい |
| `mcp-usage-control-firestore` | Firebase / GCP環境でFirestoreをauthoritative storeにしたい |

Memory storeはtest / local development向けです。複数instanceで同じquotaを共有するproductionではdistributed storeを使ってください。

## 現在のinstall方法

packageはまだnpmへ公開していません。現時点ではrepository checkoutか、ローカルでpackした`.tgz`を使います。

repositoryを検証するだけなら:

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

別applicationへinstallする正確な手順は [Source / local tarballから使う](using-from-source.ja.md) を参照してください。

要件はNode.js 20以上です。

## 最小例

まずMemory storeで動きを確認できます。

```ts
import {
  MemoryUsageStore,
  UsageControl,
  type UsagePolicy,
} from 'mcp-usage-control';

const policy: UsagePolicy = {
  quote(request) {
    return {
      decision: 'allow',
      units: 1,
      budget: {
        key: `user:${request.principal.id}:daily:2026-08-12`,
        limit: 20,
      },
    };
  },
};

const control = new UsageControl(new MemoryUsageStore(), policy);
```

このpolicyでは、1 tool call = 1 unit、1 user = 1日20 unitです。

budget keyの設計はapplication側の責任です。runtimeが「dailyだから日付を自動resetする」といった推測はしません。日次quotaなら上のように日付をkeyへ含めます。

## 複数budgetも同時に守れる

1 callをuser daily / user monthly / tenant monthlyへ同時に課金できます。

```ts
const policy: UsagePolicy = {
  quote(request) {
    const tenantId = request.principal.tenantId ?? 'personal';

    return {
      decision: 'allow',
      units: 1,
      budgets: [
        { key: `day:user:${request.principal.id}:2026-08-12`, limit: 20 },
        { key: `month:user:${request.principal.id}:2026-08`, limit: 100 },
        { key: `month:tenant:${tenantId}:2026-08`, limit: 2_000 },
      ],
    };
  },
};
```

3つのbudgetは**全部reserveできるか、1つもreserveしないか**のall-or-nothingです。

## Core APIを直接使う

```ts
const admission = await control.reserve({
  operationId: 'logical-request-123',
  principal: { id: 'user-42', tenantId: 'org-7' },
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
  await admission.lease.settle(
    admission.lease.reservedUnits,
    'error',
  );
  throw error;
}
```

### `markLiable()` は何？

「ここから先は実コストが発生した可能性がある」という境界です。

- `pending` のままexpireしたreservationはcapacityを解放できます。
- `markLiable()` 後にworkerが落ちた場合は、full reservationを保守的に残します。

process crashを無料refundとして扱わないための仕組みです。

### `settle()` は何？

reserveしたunitsと、実際に発生したunitsとの差を確定します。

`0` でsettleするのは、applicationが「metered resourceを消費していない」と判断できる場合だけにしてください。

長時間toolではlease expiryを避けるため `renew()` も使います。MCP adapterはhandler実行中のheartbeatを処理します。

## Production storeの選び方

| Store | 向いているケース | 主な注意点 |
| --- | --- | --- |
| Memory | test、local development | process間で共有できない |
| Redis | 高頻度、shared quota、低latency | Redis HA / persistence設計が必要 |
| Cloudflare Durable Objects | Cloudflare中心の構成 | Durable Objectがserialization pointになる |
| Firestore | Firebase / GCP、user単位quota中心 | 大きなshared budgetはdocument contentionに注意 |

Firestoreを使う場合は [Firestore adapter](firestore.ja.md)、Redisは [Redis adapter](redis.ja.md)、Cloudflareは [Cloudflare adapter](cloudflare.ja.md) を先に確認してください。

## MCP toolをwrapする

single-round toolには `protectTool()` を使います。

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

`protectTool()` がreserve、cost-liable化、heartbeat、handler実行、settlementまで処理します。

input schemaがないtoolでは `noInput: true` を明示してください。

### `input_required` のmulti-round tool

multi-round flowには `protectMultiRoundTool()` を使います。

初回requestだけreserveし、後続roundでは同じserver-side leaseへ再attachします。clientを往復する `requestState` はuntrustedなので、MCP SDKの `createRequestStateCodec()` と組み合わせてintegrityを検証します。

詳細な設定例は [MCP integration](mcp-integration.ja.md) を参照してください。

## Retryでは同じ `operationId` を使う

replay protectionは次のscopeです。

```text
(tenantId, principal.id, tool, operationId)
```

同じlogical operationのretryでは同じ `operationId` を使います。

`operationId` はauthentication credentialではありません。principal / tenantはtrustedなserver-side auth contextから取得してください。

## Production前チェック

- principal / tenantをclient入力からそのまま信用しない。
- retryではstableな `operationId` を使う。
- daily / monthly / tenantなど必要なbudgetを1つのquoteへ含める。
- tool実行時間に合うTTL / renew設定にする。
- zero-cost settlementは本当にcost未発生の場合だけ使う。
- store errorを「quota check失敗だからallow」に変換しない。
- distributed storeのdurability / contention特性を理解する。
- usage enforcementをfinancial ledgerそのものとして扱わない。

## 次に読む

- 実装を始める: [MCP integration](mcp-integration.ja.md)
- Storeを選ぶ: [Redis](redis.ja.md) / [Cloudflare](cloudflare.ja.md) / [Firestore](firestore.ja.md)
- 設計理由を知る: [Architecture](architecture.ja.md)
- public APIを確認する: [API reference](api-reference.ja.md)
- production security: [Security policy](../SECURITY.ja.md)
