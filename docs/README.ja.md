# ドキュメント

[English](README.md) | [日本語](README.ja.md)

このディレクトリには `mcp-usage-control` の主要ドキュメントをまとめています。

> Status: pre-alpha。v0.1まではpublic APIやpackage名が変更される可能性があります。

## はじめに読むもの

- [Getting started](getting-started.ja.md) — repositoryの準備、core lifecycle、最小構成のローカル例。
- [MCP integration](mcp-integration.ja.md) — `@modelcontextprotocol/server` v2 のtool handlerへusage controlを組み込む方法。
- [API reference](api-reference.ja.md) — current core / MCP / Redis public surfaceとdefault値。
- [Architecture](architecture.ja.md) — invariant、renewable lease、settlement semantics、責務境界。
- [Redis adapter](redis.ja.md) — atomic Lua、key model、expiry、idempotency、Redis Cluster上のtrade-off。
- [Release policy](releasing.ja.md) — pre-1.0の互換性と公開方針。
- [Changelog](../CHANGELOG.ja.md) — 主要変更とcurrent pre-alpha limitation。

## プロジェクトポリシー

- [Contributing](../CONTRIBUTING.ja.md)
- [Security policy](../SECURITY.ja.md)
- [Code of Conduct](../CODE_OF_CONDUCT.ja.md)
- [Support](../SUPPORT.ja.md)
- [License](../LICENSE)

## Package entry point

- [`@mcp-usage-control/core`](../packages/core/README.md)
- [`@mcp-usage-control/mcp`](../packages/mcp/README.md)
- [`@mcp-usage-control/redis`](../packages/redis/README.md)

## ドキュメント運用ルール

public API名やsource code identifierは英語を正とします。利用者向けドキュメントは英語・日本語の両方を維持します。

対になる日本語ドキュメントは、同じbase filenameへ `.ja` を付けます。

```text
architecture.md
architecture.ja.md
```

behaviorやinvariantを変更する場合は、可能な限り同じPull Request内で両言語を更新します。コード例も日英で同等の内容を保ちます。