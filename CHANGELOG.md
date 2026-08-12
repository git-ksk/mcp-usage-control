# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

All notable project changes are recorded here.

## [0.1.0] - 2026-08-11

Initial GitHub/source release. npm registry publication is intentionally deferred and can happen separately later.

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
- Best-effort observer delivery outside enforcement outcomes; observer failures cannot change enforcement state.
- `mcp-usage-control-mcp` adapter for `@modelcontextprotocol/server` v2 single-round tools.
- MCP result classification for normal success, `{ isError: true }`, thrown errors, classifier failure, and settlement ambiguity.
- Explicit `UnsupportedMcpUsageFlowError` for the v0.1 `input_required` support boundary.
- `mcp-usage-control-redis` with Redis-side Lua for atomic multi-budget reserve, liability, renew, settlement, expiry recovery, and tombstones.
- Redis server-time lease/tombstone decisions and Redis Cluster-compatible single-hash-slot transaction domain.
- `mcp-usage-control-cloudflare` with SQLite-backed Durable Objects, Worker-local and authenticated remote UsageStore clients, hashed transport identifiers, lazy expiry recovery, and fail-closed remote behavior.
- Explicit Cloudflare SQLite schema versioning, safe adoption of the original v1 schema, fail-closed incompatible-schema handling, and migration/rollback guidance.
- Explicit read-only Cloudflare reserve-ACK reconciliation for ambiguous remote `reserve()` acknowledgements without reserving additional quota.
- Explicit bounded Cloudflare historical-budget pruning with protected/current and active-reservation safeguards.
- Separate authenticated Cloudflare maintenance endpoint so routine usage credentials do not automatically imply deletion authority.
- Real local workerd integration coverage for Cloudflare concurrency, multi-budget atomicity, replay, expiry, renewal, lost acknowledgements, reconciliation, maintenance, authentication, and observer isolation.
- Repeatable deployed-Cloudflare dogfood procedure for a dedicated Workers Free-plan Worker + Durable Object namespace.
- Real Monokura dogfood coverage through GCP `RemoteCloudflareUsageStore` -> deployed Cloudflare Durable Objects for reserve / markLiable / renew / settle, parallel contention, retry, lost ACK, conservative settlement, and fail-close behavior.
- Cloudflare Free-plan backend-operation/capacity guidance and explicit separation of business `quota_exceeded` from platform/store unavailability.
- Real Redis 7 concurrency/crash/ACK-loss/recovery-observability integration tests.
- Official MCP SDK v2 `Client + createMcpHandler` protocol integration tests.
- Frozen `pnpm-lock.yaml` CI on Node.js 20/22.
- npm-pack tarball smoke tests, clean-consumer imports, and regression protection against leaked `workspace:` dependencies.
- English/Japanese user, architecture, Redis, Cloudflare, MCP integration, observability, API, release, security, support, and contribution documentation.

### Safety behavior

- Quota compare + reserve is atomic; no `check -> execute -> record` race.
- Process loss after execution starts does not become an automatic refund.
- Pending expiry releases every participating budget; liable expiry conservatively keeps the full reservation.
- Cost classifiers that fail or return invalid units cause full settlement before the classification error is surfaced.
- Ambiguous reserve acknowledgements are not blindly retried; Cloudflare exposes explicit read-only reconciliation instead.
- Settlement acknowledgement ambiguity remains fail-closed/conservative; identical supported replays stay idempotent.
- Cloudflare reconciliation and historical pruning never create additional quota reservations.
- Historical pruning never infers application window semantics and refuses protected/current or active-reservation budget rows.
- Redis lease/tombstone time is authoritative on Redis rather than application-host clocks.
- Admission storage/platform failures fail closed rather than becoming an allow decision.
- Observer failures are isolated from quota state and cannot turn an error/deny into an allow.

### Known limitations

- MCP v2 multi-round `input_required` is intentionally unsupported by `protectTool()` in v0.1; issue #14 tracks suspend/resume accounting.
- The deployed Cloudflare path has not intentionally exhausted shared Workers Free-plan quota; issue #24 retains real platform-limit/overload observation and deployed credential-rotation validation.
- Every budget participating in one reservation consumes the same quoted/actual unit count.
- Redis transactional state uses one configured Redis Cluster hash slot.
- Redis atomicity does not imply financial-ledger durability; persistence/HA is deployment-specific.
- Generic lease renewal is not provider-specific fencing after lease loss.
- Observability is best-effort, non-durable, not exactly-once, and is not the transactional quota ledger.
- npm publication is not part of this GitHub/source release and remains a separate explicitly authorized step.

### Compatibility

- Node.js 20+
- ESM
- `@modelcontextprotocol/server` v2 (CI currently resolves 2.0.0)
- Redis 7 integration behavior
- node-redis `redis` 6.2.x
- Cloudflare Workers / SQLite Durable Objects, with local workerd integration and deployed Free-plan dogfood

## Unreleased

### Added

- `mcp-usage-control-firestore`, a standalone server-side Firestore `UsageStore` with transactional multi-budget admission, replay protection, conservative expiry recovery, hashed storage identifiers, and adapter-local recovery observability.
- Real Firestore Emulator integration covering multi-budget atomicity, shared-budget concurrency, pending/liable expiry semantics, and idempotent settlement, plus a server-client TypeScript compatibility smoke check.
- English/Japanese Firestore deployment, contention/hotspot, source/tarball usage, API, and package documentation.

### CI

- Firestore Integration runs for Firestore adapter, core, or its own workflow changes; Firestore-only changes do not trigger Cloudflare Integration.
