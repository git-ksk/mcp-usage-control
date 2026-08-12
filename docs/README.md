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

If you are implementing a custom store, read the **[Store implementation contract](store-contract.md)** and run the reusable conformance kits before claiming compatibility.

## Understand the design

- [Project positioning](positioning.md) — the failure-safe transactional enforcement focus, competitive boundary, and what intentionally stays outside core.
- [Architecture](architecture.md) — reserve/liability/settlement, multi-budget atomicity, and crash/retry safety.
- [MCP protocol conformance](mcp-conformance.md) — the current protocol/SDK baseline, fresh-request multi-round proof, and horizontal-scale/session-affinity assumptions.
- [MCP Tasks accounting](mcp-tasks-accounting.md) — the long-running task accounting state machine and its separation from business task/result replay.
- [Store implementation contract](store-contract.md) — normative `UsageStore` / `McpUsageFlowStore` semantics, production-safety evidence, and portable conformance kits.
- [API reference](api-reference.md) — public API and defaults for core, MCP, Redis, Cloudflare, and Firestore.
- [Observability](observability.md) — lifecycle events, privacy, cardinality, and best-effort delivery.
- [Roadmap](roadmap.md) — current priorities, MCP-native correctness work, and the boundary with billing, gateways, and other external systems.

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

For pull requests that change only `docs/**` and Markdown (`*.md`) files, CI first classifies the change and then completes the required `test (20)` / `test (22)` checks through a lightweight path.

That path does not start Redis, check out the repository in the matrix jobs, set up Node.js/pnpm, install dependencies, run tests, pack packages, or install the clean consumer project. If any non-documentation path such as source code, workflows, package manifests, lockfiles, or configuration changes, the full CI matrix runs as before.

## Project policies

- [Contributing](../CONTRIBUTING.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [License](../LICENSE)

## Documentation rules

English is canonical for public API names and source identifiers. User-facing documentation is maintained in English and Japanese.

When behavior or an accounting/security invariant changes, update both language versions in the same pull request and keep examples/support boundaries semantically aligned.
