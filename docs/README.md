# Documentation

[English](README.md) | [日本語](README.ja.md)

Maintained documentation for `mcp-usage-control` v0.1.

## Start here

- [Getting started](getting-started.md) — npm/source setup, multi-budget policy, core lifecycle, Redis and MCP examples.
- [MCP integration](mcp-integration.md) — `@modelcontextprotocol/server` v2 single-round usage control and the `input_required` support boundary.
- [API reference](api-reference.md) — v0.1 core, MCP, and Redis public surface/defaults.
- [Architecture](architecture.md) — safety invariants, multi-budget atomicity, liability, idempotency, settlement, trust boundaries.
- [Redis adapter](redis.md) — v0.1 Lua transaction model, key layout, expiry, replay, Redis Cluster and durability trade-offs.
- [Release policy](releasing.md) — package/version/release procedure and pre-1.0 compatibility policy.
- [Changelog](../CHANGELOG.md) — released features, safety behavior, compatibility and known limitations.

## Project policies

- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Support](../SUPPORT.md)
- [License](../LICENSE)

## Package entry points

- [`mcp-usage-control`](../packages/core/README.md)
- [`mcp-usage-control-mcp`](../packages/mcp/README.md)
- [`mcp-usage-control-redis`](../packages/redis/README.md)

## Documentation rules

English is canonical for public API names/source identifiers. User-facing documentation is maintained in English and Japanese. Paired Japanese documents use `.ja.md`.

When behavior or an accounting/security invariant changes, update both language versions in the same pull request. Examples and support boundaries should remain semantically equivalent across translations.
