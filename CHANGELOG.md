# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

All notable project changes are recorded here.

## [Unreleased]

No entries yet.

## [0.9.0] - 2026-08-22

Ninth GitHub/source release focused on repository-wide safety hardening. npm publication remains intentionally separate and was not performed.

### Safety hardening

- Closed the v0.9 repository-audit safety set #116-#127, covering retained-budget growth integrity, safe expiry/timer arithmetic, validation before mutation, unresolved MCP growth preservation, Firestore expired-liable reconciliation, Cloudflare remote/maintenance protocol validation, malformed-policy fail-closed behavior, vector-maintenance quota integrity, Redis recovery overflow, pre-auth reconciliation buffering, strict boolean authorization, and the cross-capability regression matrix.
- Preserved the existing scalar/vector accounting, replay, liability, expiry/recovery, and fail-closed contracts while tightening provider and capability intersections rather than adding a new product surface.

### Firestore release blocker

- Resolved #143 without weakening `vector-growth-vs-settle-race`: settlement remains required to complete, and committed growth must be observed by settlement when growth wins first.
- Added bounded jittered outer retry only for definitive Firestore transaction aborts: gRPC `ABORTED` (`10`) and HTTP `409`.
- `UNKNOWN`, `UNAVAILABLE`, `INVALID_ARGUMENT`, and other ambiguous/provider failures are not added to the adapter outer-retry allow-list.
- Reduced the vector-settlement contention window by skipping budget reads/writes when settlement releases no capacity, and added a dedicated 24-iteration Firestore Emulator growth-vs-settle stress case.

### Release evidence / boundary

- PR #144 passed the Node 20/22/24 CI/package matrix, Cloudflare local workerd integration, and Firestore Emulator integration before squash merge.
- Release-preparation PR #145 aligned all five public package manifests at `0.9.0` and passed Node 20/22/24 package/clean-consumer CI, Cloudflare integration, and Firestore Emulator integration before squash merge.
- `v0.9.0` points to the exact tested release commit `e2a8f8e5dcf725a2c085faa3170a8e38e91504d2`; GitHub source-release workflow run `32568777809` completed successfully.
- Post-release registry verification confirmed that `mcp-usage-control`, `mcp-usage-control-mcp`, `mcp-usage-control-redis`, `mcp-usage-control-cloudflare`, and `mcp-usage-control-firestore` are **not published at 0.9.0**. First npm publication remains separately authorized and tracked by #6.

## [0.8.0] - 2026-08-22

Eighth GitHub/source release. npm publication remains intentionally separate and was not performed.

### Added

- Added provider-neutral scalar operation reconciliation through optional `OperationReconciliationStore`, `UsageOperationReconciliationInput`, and the common `absent` / `active` / `expired` / `settled` result vocabulary while keeping base `UsageStore` source-compatible.
- Added portable `runOperationReconciliationStoreConformance()` / `assertOperationReconciliationStoreConformance()` coverage for retained lifecycle status, repeated read-only expired observation, and fail-closed expected-state mismatch.
- Added bilingual operation-reconciliation documentation defining safe reattachment, retention-horizon semantics, explicit indeterminate/fail-closed behavior, and the boundary from business-result replay.

### Provider implementation / proof

- Memory: `reconcileOperation()` reads retained in-process scalar state without running expiry recovery or mutating accounting; process restart remains an explicit historical-absence limitation.
- Redis: a read-only Lua lookup uses Redis `TIME`, `HGET`, and `ZSCORE`; expected reserved units and budget hashes are verified, and malformed settled/tombstone state fails closed instead of becoming `absent`. Real-Redis CI runs portable reconciliation conformance.
- Firestore: a read-only transaction looks up the deterministic hashed reservation document and validates expected retained units/budget hashes without cleanup/recovery writes. Emulator CI runs portable reconciliation conformance under the existing bounded-host-clock contract.
- Cloudflare Durable Objects: the existing authenticated read-only reconciliation protocol now returns the core v0.8 result type through `reconcileRemoteCloudflareOperation()`; `reconcileRemoteCloudflareReserve()` remains as a v0.7-compatible alias and existing local/deployed lost-ACK proof carries forward.

### Safety / compatibility

- Reconciliation never reserves/releases capacity, marks liability, renews, settles, or rewrites replay state. It is status proof only.
- `absent` means only that no state is retained at lookup time; it is not historical proof after a Store retention horizon and never automatically authorizes replay.
- Backend/transport failure, corrupt/unsupported state, scalar/vector mode mismatch, and trusted expected-state mismatch reject and remain indeterminate/fail closed rather than being mapped to `absent`.
- Mutable budget limits are not historical operation identity: reconciliation verifies budget keys plus expected retained scalar units, preserving the existing same-key mutable-limit contract.
- The v0.8 generic capability is intentionally scalar-only. Vector initial-reserve ambiguity remains fail closed unless a future provider-specific mechanism proves an equivalent read-only contract.
- Business side-effect/result replay remains application-owned and separate from usage accounting.
- #81 is adopted for the future v1 stable surface as an optional scalar Store capability. #76/#82/#99 become the next v0.9 product decision gate.

### Release boundary

- All five package manifests are aligned at `0.8.0`.
- The normal release gate remains Node 20/22/24, real Redis, Cloudflare local workerd, Firestore Emulator, package tarball/content, and clean-consumer verification.
- `v0.8.0` was tagged and published as a GitHub/source release on 2026-08-22. npm publication remains deferred and separate.

## [0.7.0] - 2026-08-17

Seventh GitHub/source release. npm publication remains intentionally separate and was not performed.

### Added

- Added atomic heterogeneous usage vectors through `VectorUsagePolicy`, `VectorUsageControl`, `VectorUsageLease`, and the optional `VectorUsageStore` capability while keeping the existing scalar `UsageStore` surface source-compatible.
- Added per-dimension admission, growth, recovery, and settlement without summing unlike units. Scalar and vector reservations share one logical-operation replay domain.
- Added reservation-wide vector growth replay fencing with stable `incrementId`, one opaque Store-issued cursor, authoritative quota-denial replay, lost-ACK exact retry, and terminal-state fail-closed behavior.
- Added portable `runVectorUsageStoreConformance()` coverage for atomic partial-denial rollback, concurrency, scalar/vector operation collision, growth replay/conflicts, denied growth, pending/liable expiry, settlement bounds, and grow/settle races.
- Added English/Japanese vector design and MCP lifecycle documentation.

### Provider implementation / proof

- Memory: tagged scalar/vector reference implementation with atomic reserve/grow/settle, per-dimension recovery, and ambiguous-growth retry proof.
- Redis: additive `mode: "vector"` reservation JSON plus vector Lua transactions; existing mode-less records remain scalar. Real-Redis integration runs vector conformance and committed-growth ACK-loss replay.
- Firestore: additive optional vector fields in schema-v1 reservation documents; one transaction covers all dimensions/budgets and the next cursor is created outside automatic transaction retries. Emulator/fault-injection coverage includes vector conformance and committed-growth ACK loss.
- Cloudflare Durable Objects: schema v3 adds `reservation_vectors` without rewriting v1/v2 scalar accounting rows; `transactionSync` covers vector accounting and workerd integration exercises vector conformance plus remote committed-growth ACK-loss replay.

### Safety / compatibility

- Unlike dimensions are never converted into one scalar total. A budget key cannot belong to multiple dimensions in one vector reservation.
- Every required dimension commits atomically or none commit; independent per-dimension reserve calls are not presented as equivalent.
- Pending expiry releases every dimension; liable expiry conservatively retains every dimension. Settlement is bounded independently by total successfully reserved capacity for each dimension.
- Existing third-party scalar `UsageStore` implementations remain compatible because vector accounting is an optional capability. Existing Redis/Firestore/Cloudflare scalar data remains readable without balance/lifecycle rewrites.
- #84 is adopted for the future v1 stable surface as an optional capability; #81 becomes the next feature decision gate in v0.8.0.

### Release boundary

- All five package manifests are aligned at `0.7.0`.
- The normal release gate remains Node 20/22/24, Redis, Cloudflare local workerd, Firestore Emulator, package tarball/content, and clean-consumer verification.
- `v0.7.0` was tagged and published as a GitHub/source release on 2026-08-17. npm publication remains deferred and separate.

## [0.6.0] - 2026-08-17

Sixth GitHub/source release preparation. npm publication remains intentionally separate and is not authorized by this change.

### Added

- Added failure-safe progressive reservation growth through `UsageLease.grow()` and the optional `ProgressiveUsageStore.growReservation()` capability without making growth mandatory for existing third-party `UsageStore` implementations.
- Added stable per-increment identity plus an opaque Store-issued growth cursor. Exact retry after a lost acknowledgement replays the committed result; a different increment on a stale cursor fails closed. Authoritative quota denial also rotates the cursor without consuming capacity.
- Added portable progressive Store conformance covering sequential/replayed/concurrent growth, all-or-nothing multi-budget denial, pending/liable expiry, settlement bounds, and grow/settle races.
- Added an MCP-oriented English/Japanese example for small initial reservation, bounded top-ups, safe stop on denial/ambiguity, and same-logical-operation multi-round/Tasks handling.

### Provider implementation / proof

- Memory: reference implementation with detached Store snapshots, exact growth replay, lost-ACK before/after-commit proof, and terminal-state fail-closed behavior.
- Redis: one Lua transaction grows every participating budget and the reservation atomically, stores replay metadata in the existing reservation JSON, and keeps v0.5 rows fixed/non-growable. Redis integration runs portable progressive conformance plus committed-growth ACK-loss replay.
- Cloudflare Durable Objects: schema v2 adds a separate `reservation_growth` table without altering v1 accounting rows; `transactionSync` applies growth atomically, and local workerd integration covers portable progressive conformance and remote lost-growth-ACK replay.
- Firestore: one transaction updates the reservation and all participating budget documents; the next growth cursor is created outside the retry callback so automatic transaction retries cannot double-grow. Emulator progressive conformance and committed-growth ACK-loss fault injection cover the provider boundary.

### Safety / compatibility

- `renew()` remains lease-duration-only; capacity growth is a separate responsibility.
- Growth preserves the reservation's pending/liable state and does not renew TTL. Pending expiry releases the full grown amount; liable expiry conservatively retains the full grown amount.
- `actualUnits` remains bounded by total successfully reserved capacity. Denied increments never add capacity.
- Settled or expired/recovered reservations reject every growth call, including replay, so stale acknowledgement recovery cannot authorize new metered work after terminal state.
- v0.5 provider data remains readable. Existing Redis/Firestore records without growth metadata and Cloudflare reservations without a growth row remain fixed reservations.
- The v0.6 decision adopts progressive reservation growth for the future v1 stable surface as an optional capability. #84 becomes the next feature decision gate in v0.7.0.

### Release boundary

- All five package manifests are aligned at `0.6.0`.
- The normal release gate remains Node 20/22/24, Redis, Cloudflare local workerd, Firestore Emulator, package tarball/content, and clean-consumer verification.
- This preparation does **not** create a `v0.6.0` tag, GitHub Release, or npm publication.

## [0.5.0] - 2026-08-17

Fifth GitHub/source release. This is a pre-v1 stabilization release; npm registry publication remains intentionally deferred and is not part of this release.

### Added

- Added the optional `mcp-usage-control-cloudflare/auth` subpath with `createCloudflareBearerTokenAuthorizer()`, supporting one current and one previous Bearer token so remote Cloudflare gateways can rotate credentials without an authentication gap while preserving the mandatory application-defined `authorize(request)` contract.
- Added explicit Firestore ambiguous-commit / acknowledgement-loss guidance and fault-injection coverage for reserve, liability, renewal, and settlement retry/replay behavior.
- Added explicit Firestore bounded cross-instance clock-skew guidance plus deterministic multi-instance tests for pending/liability recovery.
- Added English/Japanese mutable quota-limit guidance covering same-key plan/override changes and application-owned policy-rollout consistency.

### Changed / hardened

- Defined the same-key mutable quota-limit contract: `budget.limit` is the effective admission ceiling for a reserve attempt while authoritative reserved/consumed usage remains in the Store; limit increases/decreases do not reset, revoke, re-price, or refund existing accounting state.
- Extended portable `UsageStore` conformance with mutable-limit increase/decrease and concurrent stale/strict policy-view cases.
- Ran the portable Store conformance contract against Memory, Redis, Cloudflare local workerd, and Firestore Emulator, including the Firestore lazy-cleanup path required by the shared conformance assumptions.
- Clarified Firestore v1-candidate support as a bounded/synchronized host-clock deployment profile with `expiryGraceMs` sized for maximum expected positive clock lead plus margin; unknown/unbounded skew remains outside the supported claim.
- Updated roadmap/readiness planning so v0.5.0 is the immediate stabilization release and the final v1 scope/API freeze remains open for post-v0.5 review. #83 progressive reservation growth and #84 heterogeneous multi-dimensional usage remain open v1-scope candidates rather than predetermined post-v1 work.

### Validation / CI

- Added Node.js 24 to the same normal full build/test/Redis/package/clean-consumer matrix as Node.js 20 and 22 without raising the public Node.js 20+ compatibility floor.
- Added real Redis portable Store conformance integration, Cloudflare local workerd portable conformance, and Firestore Emulator portable conformance.
- Added local workerd credential-rotation coverage and English/Japanese deployed-dogfood guidance for the zero-downtime sequence: copy current -> previous, replace current, move callers, then retire previous.

### Compatibility / release boundary

- This remains a backward-compatible pre-1.0 minor source release; no intentional breaking public runtime API is introduced.
- Redis, Cloudflare Durable Object, and Firestore accounting storage schemas are unchanged; no provider data migration/reset is required for v0.5.0.
- Core accounting invariants remain fail closed: atomic admission, explicit liability, replay/idempotency safety, conservative ambiguity/expiry handling, and authoritative usage preservation across mutable effective limits.
- The current runtime still uses bounded fixed reservations and one scalar unit count across participating budgets; those behaviors are v0.5 behavior and current v1 candidates, not an irreversible v1 freeze.
- Issue #24 remains open for additional real Cloudflare operational evidence and is non-blocking for this source release.
- Issue #6 remains intentionally deferred; the packages are still unpublished to npm.
- This source release does not declare v1.0 stable, publish to npm, add a first-class experimental Tasks protocol adapter, or implement #83/#84.

## [0.4.0] - 2026-08-13

Fourth GitHub/source release. npm registry publication remains intentionally deferred and is not part of this release.

### Changed

- Hardened `MemoryUsageStore` for long-running single-process use without weakening quota or replay semantics: bounded retained operations/tombstones and non-zero budget keys, fail-closed `MemoryUsageStoreCapacityError` on capacity exhaustion, `stats()` retention counters, explicit `retireBudgetKey()` for application-owned completed-window retirement, zero-unit key avoidance, and deadline-aware lazy recovery instead of scanning all reservations on every store call.
- Added English/Japanese Memory store operational guidance covering retention sizing, safe budget-window retirement, monitoring, and the boundary between controlled single-process use and provider-backed durable/shared Stores.

### Compatibility / release boundary

- This is a backward-compatible pre-1.0 minor release adding Memory-store operational APIs; no intentional breaking public API or configuration change is included.
- Redis, Cloudflare, and Firestore storage schemas are unchanged; no provider migration/reset is required for v0.4.0.
- Core accounting invariants remain unchanged: admission stays atomic, authoritative accounting/replay state is never silently evicted, and capacity exhaustion fails closed.
- Issue #24 remains open for additional real Cloudflare operational evidence and is non-blocking for source release readiness.
- Issue #6 remains intentionally deferred; the packages are still unpublished to npm.
- This source release does not declare v1.0 stable, add the experimental Tasks protocol adapter, or add a stateless MRTR mode.

## [0.3.0] - 2026-08-13

Third GitHub/source release. npm registry publication remains intentionally deferred and is not part of this release.

### Added

- Defined and proof-tested the long-running MCP Tasks accounting contract, covering one reservation per logical operation, liability, lease renewal, completion/failure/cancellation, abandonment, worker crash, ambiguous acknowledgements, and reconciliation. A stable first-class Tasks wire/runtime adapter remains deferred while the upstream integration surface is experimental.
- Added normative third-party `UsageStore` / `McpUsageFlowStore` safety contracts plus reusable `mcp-usage-control/conformance` and `mcp-usage-control-mcp/conformance` public runners. CI verifies the conformance subpaths in package tarballs and a clean consumer; backend durability/failover/ACK evidence remains provider-specific.

### Changed

- Added explicit MCP `2026-07-28` / SDK `2.0.0` conformance proof for fresh-request multi-round retries and cross-handler resume. The v1 MRTR direction is the existing shared/durable compare-and-consume model without sticky MCP sessions; a new stateless MRTR claim mode remains deferred.
- Completed the v1-readiness audit and synchronized README/API/roadmap guidance with the source-release boundary. No known design or implementation blocker requires a pre-v1 redesign or new runtime feature.
- Sharpened project positioning and roadmap guidance around the failure-safe transactional usage-enforcement boundary and post-v0.2 MCP-native correctness work.

### Release boundary

- Issue #24 remains open for additional real Cloudflare operational evidence and is non-blocking for source release readiness.
- Issue #6 remains intentionally deferred; the packages are still unpublished to npm.
- This source release does not declare v1.0 stable, does not add the experimental Tasks protocol adapter, and does not add a stateless MRTR mode.

## [0.2.0] - 2026-08-12

Second GitHub/source release. npm registry publication remains intentionally deferred and is not part of this release preparation.

### Added

- Safe MCP v2 multi-round `input_required` accounting via `protectMultiRoundTool()`, including trusted server-side suspend/resume state, integrity-protected wire `requestState`, principal/tenant/tool/argument binding, one-time resume consumption, explicit suspension TTLs, and bounded rounds.
- `UsageLease.toResumeState()` / `UsageControl.resumeLease()` for trusted server-side lease reattachment without a second quota reservation.
- `RedisMcpUsageFlowStore` as the durable shared Redis flow store for horizontally scaled MCP multi-round servers, using atomic binding-aware consume and Redis server-time expiry.
- `mcp-usage-control-firestore`, a standalone server-side Firestore `UsageStore` with transactional multi-budget admission, replay protection, conservative expiry recovery, hashed storage identifiers, and adapter-local best-effort recovery observer events.
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

### Compatibility

- Node.js 20+
- ESM
- `@modelcontextprotocol/server` v2 (CI currently exercises 2.0.0)
- Redis 7 integration behavior
- node-redis `redis` 6.2.x
- Cloudflare Workers / SQLite Durable Objects (local workerd integration plus deployed Free-plan dogfood)
