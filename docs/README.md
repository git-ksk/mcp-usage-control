# Documentation

[English](README.md) | [日本語](README.ja.md)

Maintained documentation for `mcp-usage-control` v0.1.

## Start here

- [Use from source / local tarballs](using-from-source.md) — **current installation path while npm publication is pending**; clone, verify, pack, install into another project, and smoke-test imports.
- [Getting started](getting-started.md) — multi-budget policy, core lifecycle, distributed stores, and MCP examples.
- [MCP integration](mcp-integration.md) — `@modelcontextprotocol/server` v2 single-round and opt-in `input_required` multi-round usage control.
- [Observability](observability.md) — provider-neutral lifecycle events, privacy/cardinality guidance, best-effort delivery semantics, and distributed-store recovery telemetry.
- [API reference](api-reference.md) — v0.1 core, MCP, Redis, Cloudflare, and Firestore public surface/defaults.
- [Architecture](architecture.md) — transactional usage-enforcement boundary, safety invariants, crash/ACK ambiguity, multi-budget atomicity, liability, idempotency, settlement, and trust boundaries.
- [Roadmap](roadmap.md) — invariant-first priorities and the boundary around future stores, reconciliation, Cloudflare evidence, package release, and external billing/telemetry integration.
- [Redis adapter](redis.md) — v0.1 Lua transaction model, key layout, expiry, replay, Redis Cluster and durability trade-offs.
- [Cloudflare adapter](cloudflare.md) — Durable Objects + SQLite transaction domain, Worker-local/remote use, privacy, ACK ambiguity, cleanup and cost behavior.
- [Firestore adapter](firestore.md) — server-side Firestore transaction model, contention/hotspot guidance, expiry recovery, clock semantics, and operational trade-offs.
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
- [`mcp-usage-control-cloudflare`](../packages/cloudflare/README.md)
- [`mcp-usage-control-firestore`](../packages/firestore/README.md)

## Documentation rules

English is canonical for public API names/source identifiers. User-facing documentation is maintained in English and Japanese. Paired Japanese documents use `.ja.md`.

When behavior or an accounting/security invariant changes, update both language versions in the same pull request. Examples and support boundaries should remain semantically equivalent across translations.
