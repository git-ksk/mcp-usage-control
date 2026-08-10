# ドキュメント

[English](README.md) | [日本語](README.ja.md)

`mcp-usage-control` v0.1の主要ドキュメントです。

## はじめに読むもの

- [Getting started](getting-started.ja.md) — npm / source setup、multi-budget policy、core lifecycle、Redis / MCP例。
- [MCP integration](mcp-integration.ja.md) — `@modelcontextprotocol/server` v2 single-round usage controlと `input_required` support boundary。
- [API reference](api-reference.ja.md) — v0.1 core / MCP / Redis public surfaceとdefault。
- [Architecture](architecture.ja.md) — safety invariant、multi-budget atomicity、liability、idempotency、settlement、trust boundary。
- [Redis adapter](redis.ja.md) — v0.1 Lua transaction model、key layout、expiry、replay、Redis Cluster / durability trade-off。
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

## ドキュメント運用ルール

public API名 / source identifierは英語を正とし、利用者向けdocsは英語・日本語を維持します。対になる日本語文書は `.ja.md` を使用します。

behaviorやaccounting / security invariantを変更する場合は、同じPull Requestで両言語を更新し、exampleとsupport boundaryの意味を一致させます。
