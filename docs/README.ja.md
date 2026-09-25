# 日本語ドキュメント

[English](README.md) | [日本語](README.ja.md)

`mcp-usage-control` の日本語ドキュメントです。

API名やclass名は英語のまま使いますが、説明文はできるだけ日本語として自然に読める形にしています。

> **まず動かしてみる：** [READMEのクイックスタート](../README.ja.md#クイックスタート) はデータベース不要。[Free / Plusの実行例](../examples/free-plus-credits/README.md) では同時実行と重複予約防止を確認できます。

## 初めて読むなら

最初の2ページで基本の導入を進められます。ソースからの開発・導入が必要な場合は3番目を参照してください。

1. **[はじめに](getting-started.ja.md)** — 動かせる最小例、利用枠の仕組み、パッケージとストアの選び方。
2. **[MCPサーバへの組み込み](mcp-integration.ja.md)** — `protectTool()` と `protectMultiRoundTool()` の設定。
3. **[ソース・ローカルtarballから使う](using-from-source.ja.md)** — リポジトリ開発、ローカル修正、リリースアーカイブからの導入。

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
- [MCP logical operation identity](mcp-operation-identity.ja.md) — caller idempotency keyがないsingle-round readについて、fresh-per-dispatch fallbackとexplicit retry-stable application action IDを分けるv1.1方針
- [Progressive MCP growth](progressive-mcp-integration.ja.md) — incrementally metered MCP workでのsmall reserve / top-up / safe stop pattern
- [Atomic heterogeneous usage vector](vector-usage.ja.md) — 異種unitを1 logical operationでatomicにreserve / grow / settleするv0.7 contract
- [Cost-bearing operation](cost-bearing-operations.ja.md) — bounded provider cost、shared accounting scope、billable retry、conservative ambiguity、proven-no-effect releaseを既存contractへ安全にmappingするv0.11方針
- [Persisted-state compatibility](persisted-state-compatibility.ja.md) — Redis / Firestore / Cloudflare のupgrade、rollback、future-schema fail-closed、accounting-domain resetを固定するv0.11/v1 contract
- [v1 public API / lifecycle freeze](v1-public-api-freeze.ja.md) — package名、public subpath、settlement outcome境界、status/error vocabulary、scalar/vector parity、MCP multi-round terminologyのfinal freeze
- [Vector MCP integration](vector-mcp-integration.ja.md) — MCPでvector capacityを安全に使うexplicit lifecycle pattern
- [MCP Tasks の利用量 accounting](mcp-tasks-accounting.ja.md) — long-running taskのaccounting state machineとbusiness task/result replayの分離
- [Store実装contract](store-contract.ja.md) — `UsageStore` / `McpUsageFlowStore` のnormative semantics、production-safety evidence、portable conformance kit
- [Operation reconciliation / status](operation-reconciliation.ja.md) — v0.13 scalar/vector read-only operation state contract、fail-closed ambiguity boundary、provider capability matrix、portable conformance
- [Mutable quota limit](mutable-quota-limits.ja.md) — same-key upgrade / downgrade / override semanticsとpolicy rollout consistency
- [サブスク型MCP creditsの実装パターン](subscription-credits.ja.md) — Free / Plus月次weighted credits、dynamic cost、subscription / billingとの責務境界
- [利用枠の期間を表すbudget key](accounting-window-keys.ja.md) — timezoneを明示した日次/月次keyの作り方と、config変更をaccounting identity migrationとして扱う理由
- [API reference](api-reference.ja.md) — current sourceのpublic API / package entry point
- [Observability](observability.ja.md) — lifecycle event、privacy、metric cardinality、delivery semantics
- [Operational usability](operational-usability.ja.md) — v0.10のbounded health snapshot、canonical settlement outcome、threshold / exhaustion helper
- [Roadmap](roadmap.ja.md) — current priorityとpost-v1 boundary
- [v1.0 readiness review](v1-readiness.ja.md) — production-readiness監査、blocker分類、stable / deferred境界、release時の最終確認

## 運用・リリース

- [Memory storeの長期運用](memory-store.ja.md) — bounded retention、fail-closed capacity、stats、完了済みbudget windowの明示retire
- [Persisted-state compatibility](persisted-state-compatibility.ja.md) — provider upgrade / rollback と fresh-domain reset の運用手順
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

## CIの動き

ドキュメントだけの変更（`docs/**` と任意の階層のMarkdown）は、`docs-only` でチェックアウトと `git diff --check` を実行します。集約チェック **`test (22)`** が結果を確認し、実行時テスト・パッケージのインストール・ストア統合テストは省略します。

それ以外の変更では、対象に応じたNode.js 22/24・パッケージ・依存関係の互換性・ストアの検証を実行します。詳しい条件は [貢献ガイド](../CONTRIBUTING.ja.md) と [ワークフロー](../.github/workflows/ci.yml) を参照してください。

## Project policies

- [Contributing](../CONTRIBUTING.ja.md)
- [Code of Conduct](../CODE_OF_CONDUCT.ja.md)
- [License](../LICENSE)

## 日本語ドキュメントの方針

public API名、class名、method名、source identifierは英語表記を維持します。

一方で説明文まで英語の語順や用語をそのまま持ち込まず、まず日本語で意味が分かるように書きます。必要な専門用語は、その意味を日本語で説明したうえで併記します。

behaviorやsecurity / accounting上の保証を変える場合は、英語版と日本語版で意味がずれないよう同じPull Requestで更新します。
