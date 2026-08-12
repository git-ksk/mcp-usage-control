# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**MCPサーバで、toolの利用回数や利用量の上限を安全に守るためのライブラリです。**

特に、同時実行・retry・長時間処理・process crashがある環境でも、利用枠を二重に使ってしまわないことを重視しています。

## 何を防ぐもの？

たとえば、あるユーザーの残り利用回数が1回しかないとします。

単純に「残り回数を確認 → tool実行 → 回数を減らす」という実装だと、2requestがほぼ同時に来たとき、両方が「まだ1回残っている」と判断して実行を始めることがあります。

```text
残り1回
  ├─ request A → 「1回残ってる」→ 実行
  └─ request B → 「1回残ってる」→ 実行

結果: 1回しか残っていないのに2回実行される
```

`mcp-usage-control` は、toolを実行する**前**に利用枠を予約します。

```text
利用量を決める
  ↓
利用枠を予約する（reserve）
  ↓
実コストが発生する直前に markLiable()
  ↓
toolを実行
  ↓
実際に使った量を確定する（settle）
```

先に予約することで、同じ利用枠を複数requestが同時に使うことを防ぎます。

## 何をしないライブラリ？

このprojectが扱うのは、**tool実行と利用量管理の境界**です。

次の機能そのものは提供しません。

- 決済
- 請求書発行
- subscription販売
- OAuth provider
- MCP Gateway / proxy
- 一般的なHTTP rate limiter

既存の認証・billing・MCPサーバと組み合わせて使う想定です。

## Package構成

| Package | 役割 |
| --- | --- |
| `mcp-usage-control` | 本体。Policy、UsageControl、Memory Storeを含む |
| `mcp-usage-control-mcp` | **MCPサーバのtool handlerを包むラッパー**。予約・heartbeat・settlementを自動化 |
| `mcp-usage-control-redis` | Redisを利用状況の保存先にする |
| `mcp-usage-control-cloudflare` | Cloudflare Durable Objectsを保存先にする |
| `mcp-usage-control-firestore` | Firestoreを保存先にする |

5 packageともESM / Node.js 20+です。

### `mcp-usage-control-mcp` はproxyではない

ここは名前だけだと分かりにくいですが、MCPクライアントとMCPサーバの間に置く中継サービスではありません。

```text
MCP Client
   ↓
MCP Server
   ↓
protectTool()  ← mcp-usage-control-mcp
   ↓
元のtool handler
```

MCPサーバ内で既存handlerを `protectTool()` で包み、次を自動化します。

```text
reserve
  ↓
markLiable
  ↓
heartbeat / renew
  ↓
元のhandlerを実行
  ↓
settle
```

詳しくは [MCPサーバへの組み込み](docs/mcp-integration.ja.md) を参照してください。

## 現在の配布状況

**まだnpmへ公開していません。**

現在はrepositoryをcloneして使うか、ローカルで`.tgz` packageを作って別projectへinstallします。

repositoryを確認するだけなら:

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

別projectへinstallする手順は [Source / local tarballから使う](docs/using-from-source.ja.md) を参照してください。

## 最小例

まずはMemory Storeで試せます。

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

この例では、1回のtool callで1 unit消費し、1ユーザーにつき1日20 unitまで許可します。

日付の切り替えはruntimeが自動判定しません。日次上限なら、上のように日付をbudget keyへ含めます。

## 複数の利用上限を同時に守る

1回のtool callを、複数のbudgetへ同時に計上できます。

たとえば:

- ユーザーの日次上限
- ユーザーの月次上限
- tenant全体の月次上限

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

これらはまとめて判定されます。

**全部予約できる場合だけ成功し、1つでも上限に達していれば1つも予約しません。**

## Core APIを直接使う場合

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

### `markLiable()` の意味

「ここから先は外部APIやDBなどの実コストが発生した可能性がある」と記録する境界です。

`markLiable()` 前にreservationが期限切れになった場合は、予約した利用枠を戻せます。

一方、`markLiable()` 後にprocessが落ちた場合は、本当にコストが発生していないとは言えないため、予約量を安全側に保持します。

### `settle()` の意味

予約した量と、実際に使った量との差を確定します。

最大5 unitを予約して実際には3 unitしか使わなかった場合は、`settle(3, 'success')` として残り2 unitを戻せます。

## MCPサーバへ組み込む

single-round toolなら `protectTool()` でhandlerを包みます。

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

`protectTool()` が利用枠の予約、`markLiable()`、実行中のheartbeat、結果判定、`settle()` まで担当します。

途中で `input_required` を返して別requestで再開するmulti-round toolには `protectMultiRoundTool()` を使います。

詳しくは [MCPサーバへの組み込み](docs/mcp-integration.ja.md) を参照してください。

## 本番ではどのStoreを選ぶ？

| Store | 向いている構成 | 主な注意点 |
| --- | --- | --- |
| Memory | test / local development | 1process内だけ。複数instanceでは共有不可 |
| Redis | 高頻度、tenant共有quota、低latency | HA / persistenceの設計が必要 |
| Cloudflare Durable Objects | Cloudflare中心 | Durable Objectが更新の集約点になる |
| Firestore | Firebase / GCP、ユーザー単位quota中心 | 大きな共有budgetでは同じdocumentへの更新競合に注意 |

詳しくは次を参照してください。

- [Redis](docs/redis.ja.md)
- [Cloudflare](docs/cloudflare.ja.md)
- [Firestore](docs/firestore.ja.md)

## Retryと二重計上

同じlogical operationをretryするときは、同じ `operationId` を使います。

replay protectionの範囲は次です。

```text
(tenantId, principal.id, tool, operationId)
```

`operationId` は認証情報ではありません。

principal / tenantは、認証済みsessionなど信頼できるserver-side情報から決めてください。

## Observability

`UsageObserver` を設定すると、reserve、denial、settlement、error、Store recoveryなどのeventを受け取れます。

observerは利用量を確定するtransactionそのものではなく、telemetryや分析向けです。

詳しくは [Observability](docs/observability.ja.md) を参照してください。

## 本番導入前のポイント

- principal / tenantをclient入力からそのまま信用しない
- retryではstableな `operationId` を使う
- 必要な日次・月次・tenant上限を同じquoteへ含める
- toolの実行時間に合うTTL / renew設定にする
- 実コストが発生していないと判断できる場合だけ0 unitでsettleする
- Store障害時に「判定できないからallow」へfallbackしない
- Storeのatomicityを金融帳簿そのものと同一視しない

## ドキュメント

初めて読む場合は次の順がおすすめです。

1. [はじめに](docs/getting-started.ja.md)
2. [MCPサーバへの組み込み](docs/mcp-integration.ja.md)
3. [Store別ガイド](docs/README.ja.md#利用状況の保存先を選ぶ)
4. [Architecture](docs/architecture.ja.md)
5. [API reference](docs/api-reference.ja.md)

日本語ドキュメント一覧は [docs/README.ja.md](docs/README.ja.md) を参照してください。

## Versioning / Release

Versioningは [Semantic Versioning (SemVer)](https://semver.org/) に従います。

1.0未満ではminor releaseにbreaking changeを含む場合があります。その場合はrelease notesで明示します。

詳しくは [Release policy](docs/releasing.ja.md) と [Changelog](CHANGELOG.ja.md) を参照してください。

## Security / Support

- [Security policy](SECURITY.ja.md)
- [Support](SUPPORT.ja.md)
- [Contributing](CONTRIBUTING.ja.md)
- [License](LICENSE)
