# Documentation

[English](README.md) | [日本語](README.ja.md)

User-facing documentation for `mcp-usage-control`.

> **Try it first:** the [README quick start](../README.md#quick-start) needs no database. The [Free / Plus example](../examples/free-plus-credits/README.md) checks concurrent admission and duplicate-operation protection.

## Start here

Start with the first two guides. Use the third when developing or installing from source:

1. **[Getting started](getting-started.md)** — what the library solves, the smallest example, and how to choose packages/stores.
2. **[MCP integration](mcp-integration.md)** — practical examples for `protectTool()` and `protectMultiRoundTool()`.
3. **[Use from source / local tarballs](using-from-source.md)** — contributor, unreleased-commit, local-patch, and pre-release installation paths alongside the published npm packages.

## Choose a store

| Store | Read this | Good fit |
| --- | --- | --- |
| Memory | [Memory store operations](memory-store.md) | Tests, local development, controlled single-process deployments |
| Redis | [Redis adapter](redis.md) | High frequency, shared quotas, low latency |
| Cloudflare Durable Objects | [Cloudflare adapter](cloudflare.md) | Cloudflare-centric deployments |
| Firestore | [Firestore adapter](firestore.md) | Firebase/GCP, mostly user-scoped quotas |

If you are unsure, start with the [store comparison in Getting started](getting-started.md#choosing-a-production-store).

If you are implementing a custom store, read the **[Store implementation contract](store-contract.md)** and run the reusable conformance kits before claiming compatibility.

## Understand the design

- [Project positioning](positioning.md) — the failure-safe transactional enforcement focus, competitive boundary, and what intentionally stays outside core.
- [Architecture](architecture.md) — reserve/liability/settlement, multi-budget atomicity, and crash/retry safety.
- [MCP protocol conformance](mcp-conformance.md) — the current protocol/SDK baseline, fresh-request multi-round proof, and horizontal-scale/session-affinity assumptions.
- [MCP logical operation identity](mcp-operation-identity.md) — v1.1 decision for single-round reads without a caller idempotency key: fresh-per-dispatch fallback versus explicit retry-stable application action IDs.
- [Progressive MCP growth](progressive-mcp-integration.md) — safe small-reserve/top-up/stop pattern for incrementally metered MCP work.
- [Atomic heterogeneous usage vectors](vector-usage.md) — v0.7 contract for atomically reserving, growing, and settling unlike units in one logical operation.
- [Cost-bearing operations](cost-bearing-operations.md) — v0.11 mapping for bounded provider cost, shared accounting scopes, billable retries, conservative ambiguity, and proven-no-effect release.
- [Persisted-state compatibility](persisted-state-compatibility.md) — v0.11/v1 Redis, Firestore, and Cloudflare upgrade, rollback, future-schema fail-closed, and accounting-domain reset contract.
- [v1 public API and lifecycle freeze](v1-public-api-freeze.md) — final package names, public subpaths, settlement-outcome boundary, status/error vocabulary, scalar/vector parity, and MCP multi-round terminology.
- [Vector MCP integration](vector-mcp-integration.md) — explicit MCP lifecycle for safely consuming vector capacity.
- [MCP Tasks accounting](mcp-tasks-accounting.md) — the long-running task accounting state machine and its separation from business task/result replay.
- [Store implementation contract](store-contract.md) — normative `UsageStore` / `McpUsageFlowStore` semantics, production-safety evidence, and portable conformance kits.
- [Operation reconciliation/status](operation-reconciliation.md) — v0.13 scalar/vector read-only operation-state contracts, fail-closed ambiguity boundary, provider capability matrix, and portable conformance.
- [Mutable quota limits](mutable-quota-limits.md) — same-key upgrade/downgrade/override semantics and policy-rollout consistency requirements.
- [Subscription-style MCP credits](subscription-credits.md) — canonical Free/Plus monthly weighted-credit composition, dynamic costs, and responsibility boundaries.
- [Accounting-window budget keys](accounting-window-keys.md) — deterministic calendar-day/month key construction with explicit timezone and accounting-identity migration hazards.
- [API reference](api-reference.md) — the current public source API and package entry points.
- [Observability](observability.md) — lifecycle events, privacy, cardinality, and best-effort delivery.
- [Operational usability](operational-usability.md) — v0.10 bounded health snapshots, canonical settlement outcomes, and threshold/exhaustion helpers.
- [Roadmap](roadmap.md) — current priorities and post-v1 boundaries.
- [v1.0 readiness review](v1-readiness.md) — production-readiness audit, blocker classification, stable/deferred boundary, and release-time checks.

## Operations and releases

- [Memory store operations](memory-store.md) — bounded retention, fail-closed capacity, stats, and explicit retirement of completed budget windows.
- [Persisted-state compatibility](persisted-state-compatibility.md) — provider upgrade/rollback and fresh-domain reset procedure.
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

Documentation-only changes (`docs/**` and Markdown files at any depth) run a checkout and `git diff --check` in `docs-only`. The aggregate **`test (22)`** check verifies that result. Runtime tests, package installation, and provider integration jobs are skipped on that path.

Changes outside those patterns run the applicable Node.js 22/24, package, peer-compatibility, and provider checks. See [Contributing](../CONTRIBUTING.md) and the [workflow](../.github/workflows/ci.yml) for the actual scope rules.

## Project policies

- [Contributing](../CONTRIBUTING.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [License](../LICENSE)

## Documentation rules

English is canonical for public API names and source identifiers. User-facing documentation is maintained in English and Japanese.

When behavior or an accounting/security invariant changes, update both language versions in the same pull request and keep examples/support boundaries semantically aligned.
