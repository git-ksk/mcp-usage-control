# Documentation

[English](README.md) | [日本語](README.ja.md)

User-facing documentation for `mcp-usage-control`.

## Start here

If this is your first visit, read these in order:

1. **[Getting started](getting-started.md)** — what the library solves, the smallest example, and how to choose packages/stores.
2. **[Use from source / local tarballs](using-from-source.md)** — the current installation path before npm publication.
3. **[MCP integration](mcp-integration.md)** — practical examples for `protectTool()` and `protectMultiRoundTool()`.

## Choose a store

| Store | Read this | Good fit |
| --- | --- | --- |
| Memory | [Getting started](getting-started.md) | Tests and local development |
| Redis | [Redis adapter](redis.md) | High frequency, shared quotas, low latency |
| Cloudflare Durable Objects | [Cloudflare adapter](cloudflare.md) | Cloudflare-centric deployments |
| Firestore | [Firestore adapter](firestore.md) | Firebase/GCP, mostly user-scoped quotas |

If you are unsure, start with the [store comparison in Getting started](getting-started.md#choosing-a-production-store).

## Understand the design

- [Architecture](architecture.md) — reserve/liability/settlement, multi-budget atomicity, and crash/retry safety.
- [API reference](api-reference.md) — public API and defaults for core, MCP, Redis, Cloudflare, and Firestore.
- [Observability](observability.md) — lifecycle events, privacy, cardinality, and best-effort delivery.
- [Roadmap](roadmap.md) — future direction and the boundary with billing, telemetry, and other external systems.

## Operations and releases

- [Release policy](releasing.md) — versioning, package release, and npm publication procedure.
- [Changelog](../CHANGELOG.md) — released features, compatibility changes, and known limitations.
- [Security policy](../SECURITY.md) — vulnerability reporting and security policy.
- [Support](../SUPPORT.md) — support boundaries.

## Package entry points

- [`mcp-usage-control`](../packages/core/README.md) — core + Memory store
- [`mcp-usage-control-mcp`](../packages/mcp/README.md) — MCP SDK adapter
- [`mcp-usage-control-redis`](../packages/redis/README.md) — Redis store
- [`mcp-usage-control-cloudflare`](../packages/cloudflare/README.md) — Durable Objects store
- [`mcp-usage-control-firestore`](../packages/firestore/README.md) — Firestore store

## CI behavior

For pull requests that change only `docs/**` and Markdown (`*.md`) files, CI runs only the lightweight change-classification job. The Node.js 20/22, Redis, package-pack, and clean-consumer test matrix is skipped.

If the pull request includes any non-documentation path such as source code, workflows, package manifests, lockfiles, or configuration, the full CI matrix runs as before. The workflow itself still starts for documentation-only changes so required-check behavior remains stable.

## Project policies

- [Contributing](../CONTRIBUTING.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [License](../LICENSE)

## Documentation rules

English is canonical for public API names and source identifiers. User-facing documentation is maintained in English and Japanese.

When behavior or an accounting/security invariant changes, update both language versions in the same pull request and keep examples/support boundaries semantically aligned.
