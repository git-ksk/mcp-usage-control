# Documentation

[English](README.md) | [日本語](README.ja.md)

This directory contains the maintained documentation for `mcp-usage-control`.

> Status: pre-alpha. Public APIs and package names may still change before v0.1.

## Start here

- [Getting started](getting-started.md) — repository setup, the core lifecycle, and a minimal local example.
- [MCP integration](mcp-integration.md) — wrapping `@modelcontextprotocol/server` v2 tool handlers with usage control.
- [API reference](api-reference.md) — current core, MCP, and Redis public surface and defaults.
- [Architecture](architecture.md) — invariants, renewable leases, settlement semantics, and design boundaries.
- [Redis adapter](redis.md) — atomic Lua transitions, key model, expiry, idempotency, and Redis Cluster trade-offs.
- [Release policy](releasing.md) — pre-1.0 compatibility and publication expectations.
- [Changelog](../CHANGELOG.md) — notable changes and current pre-alpha limitations.

## Project policies

- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Support](../SUPPORT.md)
- [License](../LICENSE)

## Package entry points

- [`@mcp-usage-control/core`](../packages/core/README.md)
- [`@mcp-usage-control/mcp`](../packages/mcp/README.md)
- [`@mcp-usage-control/redis`](../packages/redis/README.md)

## Documentation rules

English is the canonical language for public API names and source-code identifiers. User-facing documentation is maintained in English and Japanese.

For paired documents, the Japanese version uses the same base filename with `.ja` before `.md`, for example:

```text
architecture.md
architecture.ja.md
```

When a behavior or invariant changes, update both language versions in the same pull request whenever practical. Code examples should remain equivalent across translations.