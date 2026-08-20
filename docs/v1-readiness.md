# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

This document records the evidence accumulated toward a future v1.0. It is a **readiness assessment**, not a release instruction or an immutable API-freeze decision.

No v1.0 tag, GitHub Release, or npm publication is authorized by this document.

## Status update — v0.7 atomic-vector decision

The immediate next source release preparation target is **v0.7.0**. `v0.6.0` is the latest released source baseline.

Current execution order after v0.7 closeout is **v0.8/#81 -> v0.9/#76+#82+#99 -> v0.10 completion -> v1.0 stable promotion**. #99 was added from real GatewayMCP dogfood; its immediate consumer-side mapping bug may be fixed before v0.9, while the reusable MCPUsage contract/diagnostics remain part of the v0.9 decision gate.

The v0.7 decision for #84 is explicit:

- existing scalar `UsageStore` / `UsageControl` semantics remain source-compatible and unchanged;
- heterogeneous usage is adopted as an **optional** future-v1 capability through `VectorUsageControl`, `VectorUsageLease`, and `VectorUsageStore`;
- unlike units are never summed into one synthetic scalar;
- every required dimension/budget for one logical operation admits, grows, recovers, and settles in one authoritative Store transaction domain;
- scalar and vector reservations share one operation-idempotency domain;
- one Store-issued vector growth cursor composes v0.6 stable-increment/lost-ACK semantics across all dimensions;
- pending expiry releases every dimension, liable expiry conservatively retains every dimension, and terminal vectors reject growth replay;
- Redis, Cloudflare Durable Objects, and Firestore have provider-specific committed-vector-growth acknowledgement-loss proof in addition to portable vector conformance.

## Verdict

**GO for v0.7.0 source-release preparation, subject to the normal CI/package/provider-integration gate.**

The previously resolved v0.5/v0.6 correctness gates remain carried forward, and #84 now has a provider-neutral contract plus built-in Store proof.

**v1.0 readiness remains intentionally provisional.** #83 progressive growth and #84 atomic heterogeneous vector accounting are adopted as optional future-v1 capabilities. #81 operation reconciliation/status is the next feature decision gate in v0.8.0.

## v0.7 accounting boundary

The project now has two compatible application paths:

- **scalar path** — `UsagePolicy` -> `UsageControl` -> `UsageStore`, with optional `ProgressiveUsageStore` growth;
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

### Other open capabilities

#81 is the next v0.8 decision target. #76, #82, and #99 are the v0.9 operational-usability decisions. #99 covers canonical settlement-outcome integration vocabulary, bounded diagnostics that distinguish invalid integration input from service unavailability, and privacy-safe lifecycle visibility. They should enter v1 only if they are low-risk, clearly useful, and do not create a second accounting authority or weaken fail-closed behavior.

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

## v0.7 release checks

Before creating any v0.7.0 source tag/release:

1. version all five packages together to `0.7.0`;
2. run Node 20/22/24 normal CI;
3. run Redis scalar/progressive/vector conformance + lost-ACK integration, Cloudflare local workerd scalar/progressive/vector conformance + remote lost-vector-growth-ACK integration, and Firestore Emulator scalar/progressive/vector conformance;
4. run package tarball/content/version and clean-consumer verification, including the public vector conformance export;
5. verify English/Japanese vector/state-machine/MCP/provider-migration documentation;
6. merge the implementation PR only after required checks are green;
7. create the v0.7.0 tag/GitHub Release only with separate explicit authorization;
8. keep npm publication separate unless independently authorized.

## Future v1 release gate

A future v1.0 release should happen only after:

1. v0.5 stabilization/dogfood has produced enough operational confidence;
2. each deliberate v1-scope candidate has been explicitly accepted or deferred at its designated v0.x gate;
3. long-lived public package/subpath/API names are reviewed one final time;
4. any breaking contract change judged necessary is made before the v1 tag;
5. the full package/integration matrix is green at `1.0.0`;
6. explicit v1 source-release authorization is given.

There is no requirement that v1 immediately follow v0.5, nor that every future capability be completed before v1. The stable boundary should reflect demonstrated product need and safety evidence.

## Release / npm separation

GitHub source releases and npm publication remain separate operations. npm publication is still intentionally deferred and must not happen merely because v0.5.0 or a future v1.0 source release is ready.

## Current decision

**Next source release preparation target: v0.7.0.**

**v0.7.0 readiness: GO for release preparation, subject to normal CI/provider/package checks.**

**#83: ADOPTED for future v1 as optional progressive reservation growth.**

**#84: ADOPTED for future v1 as optional atomic heterogeneous vector usage.**

**#81: next feature decision target in v0.8.0.**

**v1.0 remains a later stable promotion with no new feature.**

**npm publication remains deferred and separate.**
