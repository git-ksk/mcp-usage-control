# ドキュメント

[English](README.md) | [日本語](README.ja.md)

`mcp-usage-control` v0.1の主要ドキュメントです。

## はじめに読むもの

- [Source / local tarballから使う](using-from-source.ja.md) — **npm公開待ちの現在のinstall手順**。clone、検証、pack、別projectへのinstall、import smoke testまで。
- [Getting started](getting-started.ja.md) — multi-budget policy、core lifecycle、distributed store、MCP例。
- [MCP integration](mcp-integration.ja.md) — `@modelcontextprotocol/server` v2 single-roundとopt-in `input_required` multi-round usage control。
- [Observability](observability.ja.md) — provider-neutral lifecycle event、privacy / cardinality指針、best-effort delivery semantics、distributed-store recovery telemetry。
- [API reference](api-reference.ja.md) — v0.1 core / MCP / Redis / Cloudflare / Firestore public surfaceとdefault。
- [Architecture](architecture.ja.md) — transactional usage-enforcement boundary、safety invariant、crash / ACK ambiguity、multi-budget atomicity、liability、idempotency、settlement、trust boundary。
- [Roadmap](roadmap.ja.md) — invariant-first priorityと、future store / reconciliation / Cloudflare evidence / package release / external billing・telemetry integrationの境界。
- [Redis adapter](redis.ja.md) — v0.1 Lua transaction model、key layout、expiry、replay、Redis Cluster / durability trade-off。
- [Cloudflare adapter](cloudflare.ja.md) — Durable Objects + SQLite transaction domain、Worker-local / remote利用、privacy、ACK ambiguity、cleanup / cost behavior。
- [Firestore adapter](firestore.ja.md) — server-side Firestore transaction model、contention / hotspot guidance、expiry recovery、clock semantics、運用trade-off。
- [Release policy](releasing.ja.md) — package / version / release procedure、pre-1.0 compatibility policy。
- [Changelog](../CHANGELOG.ja.md) — released feature、safety behavior、compatibility、known limitation。

## プロジェクトポリシー

- [Contributing](../CONTRIBUTING.ja.md)
- [Security policy](../SECURITY.ja.md)
- [Code of Conduct](../CODE_OF_CONDUCT.ja.md)
- [Support](../SUPPORT.ja.md)
- [License](../LICENSE)

## Package entry point

- [`mcp-usage-control`](../packages/core/README.md)
- [`mcp-usage-control-mcp`](../packages/mcp/README.md)
- [`mcp-usage-control-redis`](../packages/redis/README.md)
- [`mcp-usage-control-cloudflare`](../packages/cloudflare/README.md)
- [`mcp-usage-control-firestore`](../packages/firestore/README.md)

## ドキュメント運用ルール

public API名 / source identifierは英語を正とし、利用者向けdocsは英語・日本語を維持します。対になる日本語文書は `.ja.md` を使用します。

behaviorやaccounting / security invariantを変更する場合は、同じPull Requestで両言語を更新し、exampleとsupport boundaryの意味を一致させます。
