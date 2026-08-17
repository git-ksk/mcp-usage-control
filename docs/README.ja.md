# 日本語ドキュメント

[English](README.md) | [日本語](README.ja.md)

`mcp-usage-control` の日本語ドキュメントです。

API名やclass名は英語のまま使いますが、説明文はできるだけ日本語として自然に読める形にしています。

## 初めて読むなら

まずは次の3ページだけで十分です。

1. **[はじめに](getting-started.ja.md)**  
   何を解決するライブラリなのか、最小構成、各packageとStoreの違いを説明します。

2. **[Source / local tarballから使う](using-from-source.ja.md)**  
   npm公開前の現在のinstall方法です。

3. **[MCPサーバへの組み込み](mcp-integration.ja.md)**  
   `mcp-usage-control-mcp` が何をするpackageなのか、`protectTool()` / `protectMultiRoundTool()` の使い方を説明します。

## `mcp-usage-control-mcp` が分かりにくい場合

これはMCPクライアントとMCPサーバの間に置くproxyではありません。

**MCPサーバ内の既存tool handlerを包んで、利用枠の予約・更新・確定を自動化するラッパー**です。

```text
MCP Client
   ↓
MCP Server
   ↓
protectTool()
   ↓
元のtool handler
```

詳しくは [MCPサーバへの組み込み](mcp-integration.ja.md) を参照してください。

## 利用状況の保存先を選ぶ

| Store | 向いている構成 | 詳細 |
| --- | --- | --- |
| Memory | test / local development / controlled single-process | [Memory storeの長期運用](memory-store.ja.md) |
| Redis | 高頻度、tenant共有quota、低latency | [Redis adapter](redis.ja.md) |
| Cloudflare Durable Objects | Cloudflare中心の構成 | [Cloudflare adapter](cloudflare.ja.md) |
| Firestore | Firebase / GCP、ユーザー単位quota中心 | [Firestore](firestore.ja.md) |

迷った場合は [はじめに](getting-started.ja.md#本番ではどのstoreを選ぶ) の比較表から確認してください。

独自Storeを実装する場合は **[Store実装contract](store-contract.ja.md)** を読み、再利用可能なconformance kitを通してからcompatibleと判断してください。

## Firestoreを使う場合

[Firestoreを利用状況の保存先にする](firestore.ja.md) では、特に次を日本語で説明しています。

- 同じbudget keyが同じdocumentを共有する仕組み
- ユーザー単位quotaではwrite先が分散する理由
- tenant / global共有quotaで更新競合が起こりやすい理由
- reservationの期限切れをTTLだけで削除してはいけない理由
- `recoverExpired()` の使い方
- Firestore / Redis / Durable Objectsの選び分け

## 仕組みを詳しく知りたい

- [Project positioning](positioning.ja.md) — failure-safeなtransactional enforcementへ集中する理由、競争上の境界、coreへ入れないもの
- [Architecture](architecture.ja.md) — reserve、`markLiable()`、settle、retry、crash時の考え方
- [MCP protocol conformance](mcp-conformance.ja.md) — current protocol / SDK baseline、fresh-request multi-round proof、horizontal scale / session affinityの前提
- [Progressive MCP growth](progressive-mcp-integration.ja.md) — incrementally metered MCP workでのsmall reserve / top-up / safe stop pattern。
- [MCP Tasks の利用量 accounting](mcp-tasks-accounting.ja.md) — long-running taskのaccounting state machineとbusiness task/result replayの分離
- [Store実装contract](store-contract.ja.md) — `UsageStore` / `McpUsageFlowStore` のnormative semantics、production-safety evidence、portable conformance kit
- [Mutable quota limit](mutable-quota-limits.ja.md) — same-key upgrade / downgrade / override semanticsとpolicy rollout consistency
- [API reference](api-reference.ja.md) — current sourceのpublic API / package entry point
- [Observability](observability.ja.md) — lifecycle event、privacy、metric cardinality、delivery semantics
- [Roadmap](roadmap.ja.md) — current priorityとpost-v1 boundary
- [v1.0 readiness review](v1-readiness.ja.md) — production-readiness監査、blocker分類、stable / deferred境界、release時の最終確認

## 運用・リリース

- [Memory storeの長期運用](memory-store.ja.md) — bounded retention、fail-closed capacity、stats、完了済みbudget windowの明示retire
- [Release policy](releasing.ja.md) — versioning、release、npm publish手順
- [Changelog](../CHANGELOG.ja.md) — 変更履歴、互換性、既知の制約
- [Security policy](../SECURITY.ja.md) — vulnerability reportとsecurity policy
- [Support](../SUPPORT.ja.md) — support範囲

## Package一覧

- [`mcp-usage-control`](../packages/core/README.md) — core + Memory store
- [`mcp-usage-control-mcp`](../packages/mcp/README.md) — MCPサーバのtool handler用ラッパー
- [`mcp-usage-control-redis`](../packages/redis/README.md) — Redis Store
- [`mcp-usage-control-cloudflare`](../packages/cloudflare/README.md) — Durable Objects Store
- [`mcp-usage-control-firestore`](../packages/firestore/README.md) — Firestore Store

## CIについて

`docs/**` とMarkdown (`*.md`) だけを変更したPull Requestでは、CIは変更範囲を判定したあと `test (20)` / `test (22)` / `test (24)` のmatrix checkを軽量pathで終了します。

この場合はRedis起動、matrix jobでのcheckout、Node.js / pnpm setup、dependency install、test、package pack、clean consumer installを実行しません。source code、workflow、package manifest、lockfile、configなどMarkdown以外の変更が1つでも含まれる場合は、Node.js 20 / 22 / 24のfull CI matrixで同じbuild / test / package / clean-consumer evidenceを実行します。

## Project policies

- [Contributing](../CONTRIBUTING.ja.md)
- [Code of Conduct](../CODE_OF_CONDUCT.ja.md)
- [License](../LICENSE)

## 日本語ドキュメントの方針

public API名、class名、method名、source identifierは英語表記を維持します。

一方で説明文まで英語の語順や用語をそのまま持ち込まず、まず日本語で意味が分かるように書きます。必要な専門用語は、その意味を日本語で説明したうえで併記します。

behaviorやsecurity / accounting上の保証を変える場合は、英語版と日本語版で意味がずれないよう同じPull Requestで更新します。
