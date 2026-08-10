# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

All notable project changes are recorded here.

## [0.1.0] - 2026-08-10

Initial public release.

### Added

- `mcp-usage-control` core runtime with provider-neutral usage policy and store contracts.
- Atomic **multi-budget** admission: all applicable budgets reserve or none does.
- Pending -> cost-liable -> settled lifecycle with `markLiable()`.
- Renewable leases for long-running work.
- Explicit outcome-aware settlement with `actualUnits <= reservedUnits`.
- Replay protection scoped by `(tenantId, principal.id, tool, operationId)`.
- Bounded settled idempotency tombstones; Memory/Redis default to 24 hours.
- `MemoryUsageStore` reference implementation.
- Provider-neutral `UsageObserver` lifecycle hooks for admission, settlement, expiry recovery, and policy/store errors.
- Explicit opt-in event metadata; tool arguments and raw exception messages are not captured automatically.
- Best-effort observer delivery outside enforcement outcomes; returned promises are not awaited, and observer failures cannot change enforcement state.
- Explicit settlement-event replay/deduplication guidance for downstream analytics.
- `mcp-usage-control-mcp` adapter for `@modelcontextprotocol/server` v2 single-round tools.
- MCP result classification for normal success, `{ isError: true }`, and thrown errors.
- Conservative classifier-failure settlement and explicit `UsageClassificationError`.
- Explicit `UsageSettlementError` for ambiguous settlement state.
- Explicit `UnsupportedMcpUsageFlowError` for v0.1 `input_required` support boundary.
- `mcp-usage-control-redis` with Redis-side Lua for atomic multi-budget reserve, liability, renew, settlement, expiry recovery, and tombstones.
- Redis server-time lease/tombstone decisions.
- Global Redis lease index so multi-budget expiry recovery happens once per reservation.
- Aggregate Redis expiry-recovery observability without persisting raw request identities solely for telemetry.
- `mcp-usage-control-cloudflare` with SQLite-backed Durable Objects, Worker-local and authenticated remote UsageStore clients, hashed transport identifiers, lazy expiry recovery, and explicit ACK-ambiguity behavior.
- Real local workerd integration coverage for Cloudflare concurrency, multi-budget atomicity, replay, expiry, renewal, lost acknowledgements, authentication, and observer isolation.
- Redis Cluster-compatible single-hash-slot transaction domain.
- Real Redis 7 concurrency/crash/ACK-loss/recovery-observability integration tests.
- Official MCP SDK v2 `Client + createMcpHandler` protocol integration tests.
- Frozen `pnpm-lock.yaml` CI on Node.js 20/22.
- Package tarball smoke tests for exports/files/license and workspace-protocol removal.
- English/Japanese user, architecture, Redis, MCP integration, observability, API, release, security, support, and contribution documentation.

### Safety behavior

- Quota compare + reserve is atomic; no `check -> execute -> record` race.
- Process loss after execution starts does not become an automatic refund.
- Pending expiry releases every participating budget; liable expiry conservatively keeps the full reservation.
- Cost classifiers that fail or return invalid units cause full settlement before the classification error is surfaced.
- Settlement acknowledgement ambiguity is not blindly retried; identical replay is idempotent in the Redis store.
- Redis lease/tombstone time is authoritative on Redis rather than application-host clocks.
- Admission storage failures fail closed rather than becoming an allow decision.
- Observer failures are isolated from quota state and cannot turn an error/deny into an allow.

### Known limitations

- MCP v2 multi-round `input_required` is intentionally unsupported by `protectTool()` in v0.1; issue #14 tracks suspend/resume accounting.
- Every budget participating in one reservation consumes the same quoted/actual unit count.
- Redis transactional state uses one configured Redis Cluster hash slot.
- Redis atomicity does not imply financial-ledger durability; persistence/HA is deployment-specific.
- Generic lease renewal is not provider-specific fencing after lease loss.
- Observability is best-effort, non-durable, not exactly-once, and is not the transactional quota ledger. `onEvent()` is invoked inline; returned promises are not awaited. Vendor-specific telemetry adapters are outside the core package.

### Compatibility

- Node.js 20+
- ESM
- `@modelcontextprotocol/server` v2 (CI currently resolves 2.0.0)
- Redis 7 integration behavior
- node-redis `redis` 6.2.x

## Unreleased

No unreleased user-visible changes yet.
