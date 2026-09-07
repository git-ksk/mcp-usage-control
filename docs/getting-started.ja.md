# はじめに

[English](getting-started.md) | [日本語](getting-started.ja.md)

ツールに月次クレジットの上限を付け、アプリに合う連携方法と保存先を選びます。まずローカルで動く例を試し、その後で本番利用に必要な条件を確認します。

## インストール

**Node.js 22以上・ESM** を使用してください。CIの対象はNode.js 22と24です。

```sh
npm install mcp-usage-control
```

コアには `MemoryUsageStore` が含まれるため、この例には外部サービスが不要です。リポジトリやリリースアーカイブからの導入は [ソース・ローカルtarballのガイド](using-from-source.ja.md) を参照してください。

## まず覚える3つ

| 概念 | 役割 |
| --- | --- |
| **Policy** | 消費量を見積もり、適用する利用枠を選ぶ |
| **Store** | 関係するすべての利用枠を一括で予約・更新する |
| **Lease** | 予約を表す。`markLiable()`、`renew()`、`settle()` で状態を管理する |

ライブラリは利用量の制御を担当します。信頼できるユーザー情報、プランの権利、実使用量の測定、業務処理の重複実行防止はアプリ側で用意します。課金や認証は別の責務です。

## 最小構成

以下を `demo.mjs` に保存し、`node demo.mjs` で実行してください。月50クレジットの利用枠から10を予約し、模擬レポートを実行して3クレジットを確定します。未使用の7クレジットは再び利用できます。

```js
import {
  MemoryUsageStore,
  UsageControl,
  createWindowedBudgetKey,
} from 'mcp-usage-control';

const monthly = createWindowedBudgetKey({
  period: 'calendar-month',
  timeZone: 'UTC',
  namespace: 'credits',
  clock: Date.now,
});

const control = new UsageControl(new MemoryUsageStore(), {
  quote({ principal, tool }) {
    if (tool !== 'report') return { decision: 'deny', reason: 'unsupported_tool' };
    return {
      decision: 'allow',
      units: 10,
      budget: {
        key: monthly.key({ scope: 'user', id: principal.id }),
        limit: 50,
      },
    };
  },
});

// この模擬処理を、実際にリソースを消費する処理に置き換えます。
async function performMeteredWork() {
  return { text: 'Example report', actualUnits: 3 };
}

async function runReport(operationId) {
  const admission = await control.reserve({
    operationId,
    principal: { id: 'user-42' },
    tool: 'report',
    args: {},
  });
  if (!admission.allowed) {
    throw new Error(`usage denied: ${admission.reason}`);
  }

  await admission.lease.markLiable();
  let result;
  try {
    result = await performMeteredWork();
  } catch (error) {
    // 消費量が不明な場合は、予約した全量を保守的に保持します。
    await admission.lease.settle(admission.lease.reservedUnits, 'error');
    throw error;
  }

  // 処理のcatchの外に置き、確定エラーで別の確定処理を再試行しないようにします。
  await admission.lease.settle(result.actualUnits, 'success');
  return result.text;
}

console.log(await runReport('report-001')); // Example report
```

これは短時間・単一ユーザーのデモです。アプリでは認証情報からユーザーを特定し、同じ処理の再試行には同じ操作IDを使います。実使用量は判明している値を使い、予約量を超えないようにしてください。

### `markLiable()` が必要な理由

コストが発生し得る処理の直前を記録します。**pending** のまま期限切れになった予約は解放できます。**cost-liable** になった後で実使用量が不明な場合は、予約全量を保守的に保持します。有料処理の開始後にワーカーが落ちても、自動的に利用枠を返却しません。

### `settle()` は実際の消費量を確定する

実使用量を確定し、予約との差分を解放します。0で確定できるのは、リソースを消費していないとアプリが判断できる場合だけです。例外が発生したことだけでは、コストが0だとは分かりません。

確定処理の成否が不明になった場合は、直ちに別の確定処理や新規予約を行わず、選択したストアの [状態照合の契約](operation-reconciliation.ja.md) に従ってください。業務処理が成功していても利用量の確定に失敗する場合があり、業務結果の復元はアプリ側が担当します。

Core APIで長時間処理を行う場合は、処理が続く間リースを更新する必要があります。MCPラッパーは標準で更新を行います。詳しくは [MCP連携](mcp-integration.ja.md) を参照してください。

## 集計期間と複数の利用枠

この例は `createWindowedBudgetKey()` でUTCの現在の暦月を選びます。ストアが同じカウンターを自動リセットするわけではありません。キーが変わると別の利用枠になるため、タイムゾーン・名前空間・ユーザー識別方法を変えると、適用される予算も変わり得ます。

暦日・暦月には [集計期間のキー](accounting-window-keys.ja.md)、Free/Plusやツール別の消費量には [サブスク型クレジット](subscription-credits.ja.md) を参照してください。独自の課金周期はアプリ側で定義します。

1回の見積もりで `budget` の代わりに `budgets` を返すと、ユーザーの日次・月次・組織の月次上限などを同時に適用できます。**全部予約できる場合だけ成功し、1つでも不足していれば1つも予約しません。** 各キーは、意図した対象と集計期間に基づいて作ります。

## どのパッケージを使うか

| 連携方法 | インストールするもの |
| --- | --- |
| ローカルの例・独自の処理管理 | `mcp-usage-control` |
| MCP TypeScript SDK v2のツール | コア + `mcp-usage-control-mcp` |
| 利用量の永続化・共有 | 下記のストアアダプターから1つ追加 |

Redisを使うMCPサーバーの例：

```sh
npm install mcp-usage-control mcp-usage-control-mcp mcp-usage-control-redis @modelcontextprotocol/server@^2.0.0 redis@^6.2.0
```

`mcp-usage-control-mcp` はサーバー内でハンドラーを包みます。別のゲートウェイを配置するものではありません。[MCP連携ガイド](mcp-integration.ja.md) では `protectTool()`、入力スキーマのないツール、改ざん検証を伴う複数ラウンドの `input_required` を扱います。

## 本番ではどのStoreを選ぶ？

| ストア | 向いている構成 | 主な制約 |
| --- | --- | --- |
| [Memory](memory-store.ja.md) | ローカルテスト・管理された単一プロセス | 再起動で状態が失われ、別プロセスとは共有できない |
| [Redis](redis.ja.md) | 共有の利用枠・頻繁な更新 | 永続化と可用性の設計が必要 |
| [Cloudflare Durable Objects](cloudflare.ja.md) | Cloudflare上の構成 | 1つのDurable Objectが1つのトランザクション領域 |
| [Firestore](firestore.ja.md) | Firebase/GCP・主にユーザー単位の予算 | 共有範囲の大きい予算では更新が競合しやすい |

時計・永続化・障害時の条件は各ガイドに記載しています。Memoryの例が動くだけでは、本番ストアのデプロイを検証したことにはなりません。

## 再試行では同じ `operationId` を使う

重複予約の判定範囲は、保持期間中の `(tenantId, principal.id, tool, operationId)` です。重複した予約は拒否されますが、業務結果の再返却は行いません。`duplicate_operation` を回避するためだけに新しいIDを発行しないでください。

## 同時実行の検証例を動かす

Node.js 22以上と、リポジトリ指定のpnpm 10.15.0を使用します。

```sh
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm example:free-plus
```

[Free/Plusの例](../examples/free-plus-credits/README.md) は、残り10クレジットを2件のレポートのうち1件だけが予約できることと、同じ処理で再予約できないことを検証します。

## 次に読む

- ツールに組み込む：[MCP連携](mcp-integration.ja.md)
- プランを設計する：[サブスク型クレジット](subscription-credits.ja.md)
- 問題を調べる：[トラブルシューティング](troubleshooting.ja.md)
- 公開APIを確認する：[APIリファレンス](api-reference.ja.md)
- 設計を理解する：[アーキテクチャ](architecture.ja.md) / [ストア実装契約](store-contract.ja.md)
