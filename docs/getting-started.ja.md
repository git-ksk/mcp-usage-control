# はじめに

[English](getting-started.md) | [日本語](getting-started.ja.md)

このページでは、`mcp-usage-control` が何をするものかを、できるだけ日本語で説明します。

## 何をするライブラリ？

一言でいうと、**MCPのtoolを実行する前に利用枠を確保し、実行後に実際の消費量を確定するためのライブラリ**です。

たとえば、あるユーザーの残り利用回数が1回しかないとします。そこへ2件のtool callがほぼ同時に来ると、単純な実装では両方が「まだ1回残っている」と判断して処理を始めてしまうことがあります。

```text
悪い例

確認: 残り1回 ─┬─ request A → 実行開始
               └─ request B → 実行開始

結果: 1回しか残っていないのに2回実行される
```

`mcp-usage-control` は、実行前に利用枠を予約（`reserve`）します。

```text
request
  ↓
必要な利用量を決める
  ↓
利用枠を予約する（reserve）
  ↓
実コストが発生する直前に markLiable()
  ↓
toolを実行
  ↓
実際に使った量を確定する（settle）
```

そのため、同じ利用枠を複数のrequestが同時に使ってしまう競合を防げます。

このライブラリが扱うのは**利用上限の判定と実行前後の利用量管理**です。決済、請求書、サブスクリプション販売、OAuth、MCP Gatewayそのものは対象外です。

## まず覚える3つ

### Policy — 何を許可するか決める

「このtool callを許可するか」「何unit消費するか」「どの利用枠に計上するか」を決めます。

### Store — 利用状況を保存する

予約中の利用量や確定済みの利用量を保存します。

用途に応じてMemory / Redis / Cloudflare Durable Objects / Firestoreから選べます。

### Lease — 1回の実行に割り当てられた利用枠

`reserve()` に成功するとleaseが返ります。

主に次の操作を行います。

- `markLiable()` — ここから先は実コストが発生した可能性がある、と記録する
- `renew()` — 長時間処理のために有効期限を延ばす
- `settle()` — 実際に使った量を確定する

## どのpackageを使えばいい？

| Package | 役割 |
| --- | --- |
| `mcp-usage-control` | 本体。Policy、UsageControl、Memory storeを含む |
| `mcp-usage-control-mcp` | **MCPサーバのtool handlerを包むラッパー**。利用枠の予約から確定までを自動化する |
| `mcp-usage-control-redis` | Redisを利用状況の保存先にする |
| `mcp-usage-control-cloudflare` | Cloudflare Durable Objectsを保存先にする |
| `mcp-usage-control-firestore` | Firestoreを保存先にする |

### `mcp-usage-control-mcp` は中継サーバではない

ここは誤解しやすいところです。

`mcp-usage-control-mcp` は、MCPクライアントとMCPサーバの間に置くproxyやGatewayではありません。

```text
MCP Client
   ↓
MCP Server
   ↓
protectTool()  ← mcp-usage-control-mcp
   ↓
元のtool handler
```

既存のMCPサーバ内でtool handlerを `protectTool()` で包むことで、次の処理を自動化します。

```text
利用枠を予約
  ↓
実コスト発生開始を記録
  ↓
必要に応じて有効期限を延長
  ↓
元のtool handlerを実行
  ↓
成功・失敗に応じて利用量を確定
```

## 現在のインストール方法

packageはまだnpmへ公開していません。現在はrepositoryをcloneして使うか、ローカルで`.tgz`を作って別projectへinstallします。

repository自体を確認するだけなら:

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

別applicationへinstallする手順は [Source / local tarballから使う](using-from-source.ja.md) を参照してください。

Node.js 20以上が必要です。

## 最小構成

まずはMemory storeで動きを確認できます。

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

この例では「1回のtool callで1 unit消費」「1ユーザーにつき1日20 unitまで」です。

日付の切り替えはruntimeが自動判定しません。日次上限なら、上の例のように日付をbudget keyへ含めます。同じkeyはapplication policyが利用を終了するか安全にretireするまで同じaccounting bucketです。

## 複数の上限を同時に守る

1回のtool callを、複数の利用枠へ同時に計上できます。

たとえば:

- ユーザーの日次上限
- ユーザーの月次上限
- テナント全体の月次上限

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

3つの利用枠はまとめて判定されます。

**全部予約できる場合だけ成功し、1つでも不足していれば1つも予約しません。**

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

### `markLiable()` が必要な理由

`reserve()` しただけで、まだ外部APIや有料処理を呼んでいない段階なら、処理が消えたときに予約枠を戻せます。

一方、外部APIを呼び始めたあとにprocessが落ちた場合、本当にコストが発生していないとは言えません。

そこで `markLiable()` を境界として使います。

- `markLiable()` 前に期限切れ → 予約枠を戻せる
- `markLiable()` 後に期限切れ → 予約した量を保守的に残す

process crashが自動的な無料refundになるのを防ぐための仕組みです。

### `settle()` は実際の消費量を確定する

たとえば最大5 unitを予約したものの、実際には3 unitしか使わなかった場合、`settle(3, 'success')` として差分を戻せます。

`0` で確定するのは、「外部APIを呼んでいない」など、実コストが発生していないとapplication側で判断できる場合だけにしてください。

## 本番ではどのStoreを選ぶ？

| Store | 向いている構成 | 注意点 |
| --- | --- | --- |
| Memory | test、ローカル開発、restart lossを許容するcontrolled single-process用途 | restartでstate消失。複数instanceでは共有できない |
| Redis | 高頻度、共有quota、低latency | HA / persistenceの設計が必要 |
| Cloudflare Durable Objects | Cloudflare中心 | Durable Objectが更新の集約点になる |
| Firestore | Firebase / GCP、ユーザー単位quota中心 | 大きな共有budgetでは同じdocumentへの更新競合に注意 |

詳しくは [Redis](redis.ja.md)、[Cloudflare](cloudflare.ja.md)、[Firestore](firestore.ja.md) の各ページを確認してください。

## MCP toolへ組み込む

MCPサーバで `mcp-usage-control-mcp` の `protectTool()` を使うと、既存handlerへusage controlを後付けできます。

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

`protectTool()` が次を担当します。

- 実行前の利用枠予約
- handler開始直前の `markLiable()`
- 実行中のheartbeat / `renew()`
- 成功・tool error・例外の判定
- `settle()`

元のtool handlerは、本来の処理に集中できます。

input schemaがないtoolでは `noInput: true` を指定します。

### `input_required` を使うmulti-round tool

ユーザー確認などで一度 `input_required` を返し、別requestで再開するtoolには `protectMultiRoundTool()` を使います。

この場合、roundごとに新しい利用枠を予約するのではなく、**初回に予約した同じleaseを引き継ぎます**。

詳しい設定例は [MCP integration](mcp-integration.ja.md) を参照してください。

## retryでは同じ `operationId` を使う

同じ処理のretryを二重利用として数えないため、同じlogical operationでは同じ `operationId` を使います。

replay protectionの範囲は次です。

```text
(tenantId, principal.id, tool, operationId)
```

`operationId` は認証情報ではありません。ユーザーIDやtenant IDは、信頼できるserver-sideの認証情報から取得してください。

## 本番導入前の確認

- principal / tenantをclient入力からそのまま信用しない
- retryでは同じlogical operationに同じ `operationId` を使う
- 日次・月次・tenant上限など必要なbudgetを1回のquoteへ含める
- toolの実行時間に合うTTL / renew設定にする
- 実コストが発生していないと判断できる場合だけ0 unitでsettleする
- Store障害時に「判定できないからallow」へfallbackしない
- 使用するStoreのdurabilityや競合特性を理解する
- usage controlのStoreを金融帳簿そのものとして扱わない

## 次に読む

- MCPサーバへ組み込む: [MCP integration](mcp-integration.ja.md)
- Free / Plusのweighted creditsを組む: [サブスク型MCP creditsの実装パターン](subscription-credits.ja.md)
- Storeを選ぶ: [Redis](redis.ja.md) / [Cloudflare](cloudflare.ja.md) / [Firestore](firestore.ja.md)
- 内部設計を理解する: [Architecture](architecture.ja.md)
- APIを確認する: [API reference](api-reference.ja.md)
- セキュリティ: [Security policy](../SECURITY.ja.md)
