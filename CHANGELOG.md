# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

All notable project changes are recorded here. The project is currently pre-alpha and has not published its first package release.

## Unreleased

### Added

- provider-neutral `@mcp-usage-control/core` usage-control contract;
- atomic reserve-before-execute lifecycle with explicit settlement;
- pending -> cost-liable lease transition via `markLiable()`;
- renewable reservation leases and lease renewal API;
- crash-after-execution-start recovery that conservatively retains the full reservation;
- in-memory reference store with concurrency/idempotency/liability tests;
- `@mcp-usage-control/mcp` adapter for `@modelcontextprotocol/server` v2 single-round tools;
- MCP-aware classification for normal results, `{ isError: true }` tool errors, and thrown errors;
- conservative fallback settlement plus `UsageClassificationError` when cost classifiers fail or return invalid units;
- explicit `UsageSettlementError` for ambiguous settlement state;
- explicit `UnsupportedMcpUsageFlowError` for currently unsupported MCP v2 `input_required` multi-round results;
- production-oriented `@mcp-usage-control/redis` adapter using Redis-side Lua transitions;
- Redis-server-time lease/tombstone decisions instead of application `Date.now()`;
- state-dependent Redis expiry recovery and bounded idempotency tombstones;
- Redis Cluster-compatible single-hash-slot transaction domain;
- real Redis integration, crash-recovery, application-clock-independence, and ambiguous-acknowledgement fault-injection tests;
- official MCP SDK v2 `Client + createMcpHandler` in-process protocol integration tests;
- English/Japanese project, architecture, Redis, integration, API, security, support, contribution, and release documentation;
- bilingual GitHub issue forms and pull-request template.

### Changed

- operation-key input is tuple-encoded before hashing/string storage to avoid delimiter ambiguity;
- `UsageDeniedError` keeps its detailed `.reason` programmatically but uses a generic human-readable message to avoid accidental MCP disclosure;
- cost-liable lease expiry charges conservatively instead of releasing reserved units;
- Redis lease timing is authoritative on the Redis server rather than application instances;
- Redis documentation now distinguishes Lua atomicity from persistence/failover durability and documents lazy-cleanup backlog behavior;
- release gates now require crash semantics, MCP result semantics, protocol integration coverage, and an explicit `input_required` support decision.

### Known pre-alpha limitations

- one budget per reservation; atomic multi-budget admission is still planned for v0.1;
- MCP v2 `input_required` multi-round suspend/resume accounting is not implemented;
- principal/tenant/tool idempotency scoping is still being finalized;
- package names and public APIs may change;
- workspace packages remain private and unpublished;
- `pnpm-lock.yaml` is not committed yet; frozen reproducible installs are a v0.1 release gate;
- generic lease renewal does not provide provider-specific fencing after lease loss;
- Redis atomicity does not imply financial-ledger durability.

## Release entries

Once tagged releases begin, each release entry should include the release date, breaking changes, invariant changes, storage/migration notes, and supported runtime dependencies. See [Release policy](docs/releasing.md).