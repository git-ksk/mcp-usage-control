# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

All notable project changes are recorded here.

## [0.3.0] - 2026-08-13

Release candidate for the next GitHub/source release. npm registry publication remains intentionally deferred and is not part of this release preparation. No v0.3.0 tag or GitHub Release is created by this PR.

### Added

- Defined and proof-tested the long-running MCP Tasks accounting contract, covering one reservation per logical operation, liability, lease renewal, completion/failure/cancellation, abandonment, worker crash, ambiguous acknowledgements, and reconciliation. A stable first-class Tasks wire/runtime adapter remains deferred while the upstream integration surface is experimental.
- Added normative third-party `UsageStore` / `McpUsageFlowStore` safety contracts plus reusable `mcp-usage-control/conformance` and `mcp-usage-control-mcp/conformance` public runners. CI verifies the conformance subpaths in package tarballs and a clean consumer; backend durability/failover/ACK evidence remains provider-specific.

### Changed

- Added explicit MCP `2026-07-28` / SDK `2.0.0` conformance proof for fresh-request multi-round retries and cross-handler resume. The v1 MRTR direction is the existing shared/durable compare-and-consume model without sticky MCP sessions; a new stateless MRTR claim mode remains deferred.
- Completed the v1-readiness audit and synchronized README/API/roadmap guidance with the current source boundary. No known design or implementation blocker requires a pre-v1 redesign or new runtime feature.
- Sharpened project positioning and roadmap guidance around the failure-safe transactional usage-enforcement boundary and post-v0.2 MCP-native correctness work.

### Release boundary

- Issue #24 remains open for additional real Cloudflare operational evidence and is non-blocking for source release readiness.
- Issue #6 remains intentionally deferred; the packages are still unpublished to npm.
- This release candidate does not declare v1.0 stable, does not add the experimental Tasks protocol adapter, and does not add a stateless MRTR mode.

## [0.2.0] - 2026-08-12

Second GitHub/source release. npm registry publication remains intentionally deferred and is not part of this release preparation.

### Added

- Safe MCP v2 multi-round `input_required` accounting via `protectMultiRoundTool()`, including trusted server-side suspend/resume state, integrity-protected wire `requestState`, principal/tenant/tool/argument binding, one-time resume consumption, explicit suspension TTLs, and bounded rounds.
- `UsageLease.toResumeState()` / `UsageControl.resumeLease()` for trusted server-side lease reattachment without a second quota reservation.
- `RedisMcpUsageFlowStore` as the durable shared Redis flow store for horizontally scaled MCP multi-round servers, using atomic binding-aware consume and Redis server-time expiry.
- `mcp-usage-control-firestore`, a standalone server-side Firestore `UsageStore` with transactional multi-budget admission, replay protection, conservative expiry recovery, hashed storage identifiers, and adapter-local recovery observability.
- Successful admission `remainingByBudget` propagation plus a low-cardinality `projectUsageEvent()` structured-log projection that excludes identities, tool/budget keys, settlement outcomes, and raw application reasons by default.
- Bounded full-call Cloudflare remote timeouts and HTTP status metadata on transport errors without exposing response bodies.
- Real Firestore Emulator integration covering multi-budget atomicity, shared-budget concurrency, pending/liable expiry semantics, idempotent settlement, and server-client TypeScript compatibility.

### Packaging / CI / docs

- All five publishable packages are versioned `0.2.0`.
- Redis `mcp-usage-control-redis/mcp-flow` is now an explicit public export and included in the npm tarball allow-list; clean-consumer CI imports it directly.
- Node.js 20/22 CI now verifies all package versions stay aligned and derives tarball names from the package version instead of hard-coding a release number.
- Firestore integration is isolated from Cloudflare integration triggers, while required CI checks keep a lightweight docs-only path and conservatively fall back to full CI when change scope is uncertain.
- English/Japanese architecture, MCP multi-round, Redis flow-store, Firestore, observability, source/tarball, API, release, security, and contributor documentation are synchronized with the v0.2 behavior.

### Security / accounting invariants

- Quota reservation remains atomic across all participating budgets; no `check -> execute -> record` race is introduced by the new adapters or MCP multi-round flow.
- MCP resume state kept by the server is never treated as a client credential; wire state is an integrity-protected opaque reference, and resume is bound to principal, optional tenant, tool, and arguments.
- A matching MCP resume token is consumed exactly once; mismatches do not consume the legitimate flow, and ambiguous/lost consume acknowledgements fail closed rather than re-entering application work.
- Multi-round work is marked cost-liable before handler execution. If a claimed process disappears, the reservation expires conservatively at its full reserved charge.
- Firestore reserve/settle/recovery changes run inside transactions; expired pending reservations release capacity, while expired liable reservations retain the conservative charge.
- Firestore document IDs hash operation/budget identity material before storage. The adapter is server-side only and does not grant clients direct write authority over enforcement state.
- Observability remains best-effort and isolated from enforcement; the structured projection is low-cardinality and secret-conscious by default.
- Cloudflare remote failures remain fail-closed, reserve reconciliation remains read-only, and response bodies are not propagated through transport errors.

### Compatibility / known limitations

- Node.js 20+; CI exercises Node.js 20 and 22.
- ESM.
- `@modelcontextprotocol/server` / client v2; CI exercises 2.0.0 and the official `Client + createMcpHandler` protocol path.
- Redis 7 integration behavior with node-redis `redis` 6.2.x.
- Cloudflare Workers / SQLite Durable Objects with local workerd integration.
- Firestore is tested against the Firebase Local Emulator Suite and `@google-cloud/firestore` 8.7.0 type compatibility.
- Firestore uses host-clock lease timestamps with a configurable expiry grace and can hotspot on heavily shared budget documents; deployment guidance documents these limits.
- Redis flow state is atomic within each flow's Cluster hash slot, but Redis persistence/HA remains deployment-specific.
- `protectTool()` stays single-round; `input_required` requires the opt-in `protectMultiRoundTool()` path.
- npm publication is still a separate manual operation and is not performed by this release PR.

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
