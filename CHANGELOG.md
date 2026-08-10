# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

All notable project changes are recorded here. The project is currently pre-alpha and has not published its first package release.

## Unreleased

### Added

- provider-neutral `@mcp-usage-control/core` usage-control contract;
- atomic reserve-before-execute lifecycle with explicit settlement;
- renewable reservation leases and lease renewal API;
- in-memory reference store with concurrency/idempotency tests;
- `@mcp-usage-control/mcp` adapter for `@modelcontextprotocol/server` v2;
- default MCP lease heartbeat for long-running handlers;
- conservative error settlement and explicit success/error unit classification;
- explicit `UsageSettlementError` for ambiguous settlement state;
- production `@mcp-usage-control/redis` adapter using Redis-side Lua transitions;
- Redis expiry recovery and bounded idempotency tombstones;
- Redis Cluster-compatible single-hash-slot transaction domain;
- real Redis integration and ambiguous-acknowledgement fault-injection tests;
- English/Japanese project, architecture, Redis, integration, API, security, support, contribution, and release documentation;
- bilingual GitHub issue forms and pull-request template.

### Changed

- reservations are treated as renewable leases rather than fixed TTL reservations;
- MCP execution failures are separated from settlement failures so ambiguous settlement is not blindly retried;
- Redis identifiers are hashed before storage rather than embedding raw principal/operation/budget identifiers into key names.

### Known pre-alpha limitations

- one budget per reservation; atomic multi-budget admission is still planned for v0.1;
- package names and public APIs may change;
- workspace packages remain private and unpublished;
- generic lease renewal does not provide provider-specific fencing after lease loss.

## Release entries

Once tagged releases begin, each release entry should include the release date, breaking changes, invariant changes, storage/migration notes, and supported runtime dependencies. See [Release policy](docs/releasing.md).