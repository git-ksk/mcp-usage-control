# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

This document records the evidence accumulated toward a future v1.0. It is a **readiness assessment**, not a release instruction or an immutable API-freeze decision.

No v1.0 tag, GitHub Release, or npm publication is authorized by this document.

## Status update — v0.8 operation-reconciliation decision

`v0.8.0` is the latest released GitHub/source baseline and is closed out. **v0.9.0 / #76 + #82 + #99 is the active product decision target.**

After v0.8, the execution order is **v0.9/#76+#82+#99 -> v0.10/#24+#6+#105+#106 completion -> v1.0 stable promotion**. #99 came from real GatewayMCP dogfood; its immediate consumer-side mapping bug may land earlier while reusable MCPUsage diagnostics stay in the v0.9 decision gate.

The v0.8 decision for #81 is explicit:

- adopt scalar operation reconciliation as an **optional** future-v1 Store capability;
- keep the base `UsageStore` source-compatible;
- use the common read-only `absent` / `active` / `expired` / `settled` result vocabulary;
- make backend/transport failure, unsupported/corrupt state, and trusted-input mismatch indeterminate and fail closed rather than mapping them to `absent`;
- never allocate a second reservation or mutate liability, renewal, settlement, recovery, or replay state during reconciliation;
- support the optional interface in Memory, Redis, and Firestore, while Cloudflare exposes the same core vocabulary through its authenticated reconciliation subpath;
- add portable scalar reconciliation conformance while retaining provider-specific lost-ACK, time, durability, and failover evidence;
- keep v0.8 reconciliation scalar-only; generic vector initial-reserve ambiguity remains fail closed;
- keep business-result replay and business-side idempotency application-owned.

## Verdict

**v0.8.0 source release is COMPLETE. The next product decision gate is v0.9.0 / #76 + #82 + #99.**

The resolved v0.5-v0.7 correctness gates remain carried forward, and #81 now has a provider-neutral contract, built-in Store support matrix, portable conformance, and Cloudflare provider-specific reconciliation evidence.

**v1.0 readiness remains intentionally provisional.** #83, #84, and #81 are adopted as optional future-v1 capabilities. **#76, #82, and #99 are the next v0.9 product decision gate.**

## v0.8 accounting boundary

The project now has two compatible application paths:

- **scalar path** — `UsagePolicy` -> `UsageControl` -> `UsageStore`, with optional `ProgressiveUsageStore` growth and optional scalar `OperationReconciliationStore` read-only status;
- **vector path** — `VectorUsagePolicy` -> `VectorUsageControl` -> optional `VectorUsageStore`.

Stable invariants across both paths:

- one logical operation keeps one replay identity `(tenantId, principal.id, tool, operationId)`;
- every budget/dimension required for one admission commits atomically or none commit;
- metered work is preceded by explicit liability;
- renewal changes lease duration only;
- ambiguous state-changing results fail closed and require exact replay/reconciliation;
- pending expiry may release capacity; liable unknown usage is conservative;
- settlement is bounded by successfully reserved capacity;
- business result replay remains application-owned.

Vector-specific invariants:

- each dimension has its own units and budget topology;
- a budget key cannot belong to multiple dimensions in one vector;
- settlement reports every dimension exactly once and releases unused units only from that dimension's budgets;
- vector growth uses one stable `incrementId` and one reservation-wide opaque cursor while retaining the complete topology;
- independent per-dimension reserve calls are never presented as an atomic vector equivalent.

## v1 scope decisions

### #83 — progressive reservation growth — ADOPTED in v0.6

Progressive scalar growth remains an optional Store extension. The proof covers atomic all-budget growth, deterministic increment replay identity, lost-ACK fencing, pending/liable inheritance, conservative expiry/recovery, terminal-state rejection, and settlement bounded by total successfully reserved capacity.

See [Progressive reservation growth](progressive-reservation-growth.md) and [Progressive MCP growth](progressive-mcp-integration.md).

### #84 — heterogeneous multi-dimensional usage — ADOPTED in v0.7

The v0.7 proof adopts an optional vector surface rather than changing the scalar contract. It covers all-or-nothing dimension admission, one logical replay identity, hierarchical budgets inside dimensions, atomic per-dimension settlement, progressive vector growth/replay, pending/liable recovery, scalar/vector operation collision, and provider-neutral Store conformance.

Memory is the reference implementation. Redis uses one Lua transaction with additive vector JSON metadata; Firestore uses one retried transaction with additive optional reservation fields; Cloudflare Durable Objects use SQLite `transactionSync` plus schema-v3 `reservation_vectors` sidecar metadata. Existing scalar provider data remains readable without migration/rewrite.

See [Atomic heterogeneous usage vectors](vector-usage.md) and [Vector MCP integration](vector-mcp-integration.md).

### #81 — operation reconciliation/status — ADOPTED in v0.8

The v0.8 proof adopts an optional scalar read-only capability. Memory, Redis, and Firestore implement `OperationReconciliationStore`; Cloudflare exposes the same result vocabulary through `reconcileRemoteCloudflareOperation()` while retaining the v0.7 reserve-specific alias. Reconciliation never creates capacity or authorizes business replay. Unknown/unprovable state rejects and remains fail closed. The portable conformance runner covers retained lifecycle status, repeated expired-state reads without mutation, and expected-state mismatch.

See [Operation reconciliation/status](operation-reconciliation.md).

### Other open capabilities

#76, #82, and #99 are the v0.9 operational-usability decisions. #99 covers canonical settlement-outcome integration vocabulary, bounded diagnostics that distinguish invalid integration input from service unavailability, and privacy-safe lifecycle visibility. They should enter v1 only if they are low-risk, clearly useful, and do not create a second accounting authority or weaken fail-closed behavior.

First-class MCP Tasks integration likewise remains dependent on the upstream TypeScript protocol surface; the accounting lifecycle itself is already defined and proof-tested.

## Production-readiness evidence

### Public API / packaging / Node

- all five publishable package manifests are version-aligned for each source release;
- ESM and Node.js 20+ remain the public compatibility floor;
- normal CI exercises Node.js 20, 22, and 24 on the same build/test/package/clean-consumer path;
- public subpath exports are enumerated and package tarball contents are allow-listed;
- clean-consumer CI installs locally packed tarballs and imports public entry points.

### Store invariant alignment

- **Memory** — process-local reference implementation with bounded retained state and fail-closed capacity exhaustion;
- **Redis** — one Lua transaction domain, Redis server time, concurrency/expiry/replay/ACK-loss evidence;
- **Cloudflare Durable Objects** — Durable Object + SQLite transaction domain, local workerd conformance, deployed dogfood, explicit remote ambiguity handling, and optional two-token credential rotation;
- **Firestore** — transactions with hashed identifiers, explicit ambiguous-ACK behavior, and bounded/synchronized-host-clock deployment contract with deterministic skew evidence.

Portable Store conformance exercises the common mutable-limit and lifecycle contract across Memory, Redis, Cloudflare local workerd, and Firestore Emulator. Passing portable conformance proves behavioral compatibility, not backend durability/HA/failover by itself.

### Failure semantics covered

Evidence covers:

- concurrent shared-budget admission;
- multi-budget all-or-nothing behavior;
- duplicate logical-operation rejection;
- idempotent liability and terminal settlement replay;
- conflicting settlement rejection;
- pending expiry release and liable expiry conservative retention;
- lease renewal;
- provider-specific lost-ACK/retry evidence;
- Firestore multi-instance bounded-skew recovery;
- same-key mutable limit increase/decrease without resetting authoritative usage;
- one-time multi-round resume, mismatch preservation, and fail-closed ambiguous consume;
- separation of usage-accounting recovery from blind business-operation replay.

Cancellation remains conservative: a cancellation request/ACK is not proof that no metered cost occurred.

## Mutable policy boundary

For the same `budget.key`, `budget.limit` is the effective admission ceiling supplied for that call while authoritative used/reserved state remains in the Store.

- increases preserve existing usage and open only new headroom;
- decreases preserve usage/reservations and deny new work while at/above the lower limit;
- active reservations are not re-priced or revoked by a policy change;
- settled usage is not refunded by lowering a limit;
- key changes are reserved for genuinely different application-owned accounting buckets/windows;
- Store atomicity does not provide distributed policy-version consensus across application instances.

See [Mutable quota limits](mutable-quota-limits.md).

## Security / horizontal-scale boundary

- `Principal` is trusted application input derived from authentication/authorization;
- `operationId` is idempotency input, not identity proof;
- MCP request state is integrity-verified and rebound to trusted identity/tool/args context;
- remote Cloudflare requires application-defined authorization and HTTPS outside local tests;
- Firestore is server-side enforcement infrastructure;
- raw tool arguments and secrets are not collected by default for enforcement telemetry;
- production horizontal scale requires shared provider-backed accounting/flow state where appropriate;
- Firestore's supported lease-recovery profile requires bounded/synchronized host clocks and correctly sized `expiryGraceMs`.

## v0.8 release evidence

The v0.8.0 source release was created from tagged commit `2877057c2015717f75decefd3f72c9731147fb8b` after the required release gates were green. The implementation PR head and merged main commit had the same Git tree, and the release workflow then re-ran package checks from the tag. The completed gate included:

1. version all five packages together to `0.8.0`;
2. run Node 20/22/24 normal CI with real Redis;
3. run portable scalar operation-reconciliation conformance for Memory/Redis/Firestore, Cloudflare local workerd reconciliation integration, and existing scalar/progressive/vector provider suites;
4. run Firestore Emulator and Cloudflare workerd integration;
5. run package tarball/content/version and clean-consumer verification, including the public reconciliation conformance export;
6. merge only after required CI and CodeQL checks were green;
7. tag/release the tested content as `v0.8.0`;
8. keep npm publication separate unless independently authorized.

The tag and GitHub Release were published on 2026-08-22. npm publication was not performed and remains deferred.

## v0.7 release evidence

The v0.7.0 source release was created from tagged commit `bf4a6dfcf21c92634e4ba9ede5dcd889b3867612` after the required release gates were green. The completed gate was:

1. version all five packages together to `0.7.0`;
2. run Node 20/22/24 normal CI;
3. run Redis scalar/progressive/vector conformance + lost-ACK integration, Cloudflare local workerd scalar/progressive/vector conformance + remote lost-vector-growth-ACK integration, and Firestore Emulator scalar/progressive/vector conformance;
4. run package tarball/content/version and clean-consumer verification, including the public vector conformance export;
5. verify English/Japanese vector/state-machine/MCP/provider-migration documentation;
6. merge the implementation PR only after required checks are green;
7. tag/release the exact tested commit as `v0.7.0`;
8. keep npm publication separate unless independently authorized.

The tag and GitHub Release were published on 2026-08-17. npm publication was not performed and remains deferred.

## Future v1 release gate

A future v1.0 release should happen only after:

1. the pre-v1 v0.x ladder has produced enough operational confidence;
2. each deliberate v1-scope candidate has been explicitly accepted or deferred at its designated v0.x gate;
3. the supported Node.js floor is explicitly frozen (#105) and package `engines`, CI, security/support claims, and clean-consumer evidence agree;
4. Redis / Firestore / Cloudflare persisted-state upgrade, newer-schema fail-closed, migration, and rollback semantics are explicitly frozen (#106);
5. long-lived public package/subpath/API names are reviewed one final time;
6. any breaking contract change judged necessary is made before the v1 tag;
7. the full package/integration/registry matrix is green at `1.0.0`;
8. explicit v1 source-release authorization is given.

There is no requirement that v1 immediately follow v0.5, nor that every future capability be completed before v1. The stable boundary should reflect demonstrated product need and safety evidence.

## Release / npm separation

GitHub source releases and npm publication remain separate operations. npm publication is still intentionally deferred and must not happen merely because a GitHub/source release is ready; #6 remains the separately authorized first registry publication gate.

## Current decision

**Current released source baseline: v0.8.0 — RELEASED / CLOSED.**

**Active product decision target: v0.9.0 / #76 + #82 + #99 — operational usability / dogfood diagnostics.**

**#83: ADOPTED for future v1 as optional progressive reservation growth.**

**#84: ADOPTED for future v1 as optional atomic heterogeneous vector usage.**

**#81: ADOPTED for future v1 as optional scalar read-only operation reconciliation.**

**Next product decision target: v0.9.0 / #76 + #82 + #99.**

**v1.0 remains a later stable promotion with no new feature.**

**npm publication remains deferred and separate.**
