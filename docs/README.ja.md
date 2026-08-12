# ドキュメント

[English](README.md) | [日本語](README.ja.md)

`mcp-usage-control` の利用者向けドキュメントです。

## まず読む

初めてなら、この順で十分です。

1. **[Getting started](getting-started.ja.md)** — 何を解決するライブラリか、最小例、package / storeの選び方。
2. **[Source / local tarballから使う](using-from-source.ja.md)** — npm公開前の現在のinstall手順。
3. **[MCP integration](mcp-integration.ja.md)** — `protectTool()` と `protectMultiRoundTool()` の実装例。

## Storeを選ぶ

| Store | まず読むページ | 向いているケース |
| --- | --- | --- |
| Memory | [Getting started](getting-started.ja.md) | test / local development |
| Redis | [Redis adapter](redis.ja.md) | 高頻度、shared quota、低latency |
| Cloudflare Durable Objects | [Cloudflare adapter](cloudflare.ja.md) | Cloudflare中心の構成 |
| Firestore | [Firestore adapter](firestore.ja.md) | Firebase / GCP、user単位quota中心 |

迷ったら [Getting startedのstore比較](getting-started.ja.md#production-storeの選び方) から確認してください。

## 仕組みを深く知る

- [Architecture](architecture.ja.md) — reserve / liability / settlement、multi-budget atomicity、crash / retry時の安全性。
- [API reference](api-reference.ja.md) — core / MCP / Redis / Cloudflare / Firestoreのpublic APIとdefault。
- [Observability](observability.ja.md) — lifecycle event、privacy、cardinality、best-effort delivery。
- [Roadmap](roadmap.ja.md) — 今後の方向性と、billing / telemetryなど外部systemとの境界。

## 運用・リリース

- [Release policy](releasing.ja.md) — versioning、package release、npm publish手順。
- [Changelog](../CHANGELOG.ja.md) — released feature、互換性、known limitation。
- [Security policy](../SECURITY.ja.md) — vulnerability reportとsecurity policy。
- [Support](../SUPPORT.ja.md) — support範囲。

## Package entry points

- [`mcp-usage-control`](../packages/core/README.md) — core + Memory store
- [`mcp-usage-control-mcp`](../packages/mcp/README.md) — MCP SDK adapter
- [`mcp-usage-control-redis`](../packages/redis/README.md) — Redis store
- [`mcp-usage-control-cloudflare`](../packages/cloudflare/README.md) — Durable Objects store
- [`mcp-usage-control-firestore`](../packages/firestore/README.md) — Firestore store

## Project policies

- [Contributing](../CONTRIBUTING.ja.md)
- [Code of Conduct](../CODE_OF_CONDUCT.ja.md)
- [License](../LICENSE)

## ドキュメント運用ルール

public API名 / source identifierは英語を正とし、利用者向けdocsは英語・日本語を維持します。

behaviorやaccounting / security invariantを変更する場合は、同じPull Requestで両言語を更新し、exampleとsupport boundaryの意味を揃えます。
