# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

This document records the evidence accumulated toward a future v1.0. It is a **readiness assessment**, not a release instruction or an immutable API-freeze decision.

No v1.0 tag, GitHub Release, or npm publication is authorized by this document.

## Status update — v0.5 before v1

The immediate next source release is **v0.5.0**.

The repository previously reached a point where the current fixed-reservation / scalar-unit model could have been frozen for v1. That conclusion remains evidence that the existing model is internally coherent, but the project is intentionally taking one more pre-1.0 stabilization release before committing to the final v1 surface.

Therefore, statements from the earlier review that #83/#84 were *definitively post-v1* are superseded by the current plan:

- v0.5.0 keeps the current bounded fixed-reservation model;
- v0.5.0 keeps one scalar quoted/actual unit count across all budgets participating in one reservation;
- #83 progressive reservation growth remains an open **v1-scope candidate**;
- #84 heterogeneous multi-dimensional usage remains an open **v1-scope candidate**;
- either capability may still remain post-v1 if its design cannot preserve the existing safety guarantees with sufficient evidence.

This is a release-planning change, not a rollback of the correctness work already completed.

## Verdict

**GO for v0.5.0 stabilization/source release.**

The identified correctness/evidence gates are resolved:

- #77 — Firestore ambiguous-commit / acknowledgement-loss semantics;
- #78 — Firestore bounded cross-instance clock-skew safety;
- #79 — Node.js 24 full compatibility-evidence matrix;
- #85 — mutable quota-limit semantics for an existing accounting bucket.

No known defect in those areas requires holding v0.5.0.

**v1.0 readiness remains intentionally provisional.** The final v1 scope should be chosen after v0.5 experience, including explicit reconsideration of #83/#84 and any other low-risk/high-value capability that would be materially harder to add after a stable API commitment.

## v0.5 accounting boundary

v0.5.0 preserves the currently proven contract:

- `UsagePolicy` quote followed by atomic `UsageStore.reserve()`;
- all-or-nothing multi-budget admission;
- one scalar quoted/actual unit count applied to every budget participating in one reservation;
- a bounded fixed reservation established before metered work;
- `actualUnits <= reservedUnits`;
- replay identity `(tenantId, principal.id, tool, operationId)`;
- explicit `pending -> cost-liable` transition via `markLiable()`;
- renewable leases;
- conservative expiry after liability;
- identical settlement replay and conflicting-settlement rejection;
- fail-closed storage semantics;
- same-key mutable effective limits that preserve authoritative reserved/consumed usage;
- Memory, Redis, Cloudflare Durable Objects, and Firestore Stores under their documented deployment constraints;
- single-round and supported multi-round MCP TypeScript SDK v2 accounting paths;
- shared/durable one-time multi-round flow claims without sticky MCP session affinity;
- provider-neutral observability that cannot change enforcement outcomes;
- portable `UsageStore` / `McpUsageFlowStore` conformance runners.

A second logical operation is not treated as an accounting-equivalent top-up workaround. Independent per-dimension reserve calls are not treated as equivalent when all dimensions must admit atomically.

## v1 scope questions intentionally left open

### #83 — progressive reservation growth

The feature can enter v1 if the design proves, before API freeze:

- every increment is atomically admitted across all participating budgets or not applied;
- one top-up attempt has deterministic retry/idempotency identity;
- lost ACK after a committed increment cannot duplicate capacity;
- pending vs. cost-liable semantics remain explicit;
- expiry/recovery retains the correct conservative charge after one or more increments;
- settlement cannot exceed total successfully reserved capacity;
- long-running / multi-round execution does not create a second logical operation merely to gain capacity.

If this proof is not ready, v1 may retain the v0.5 fixed-reservation model and add top-up later.

### #84 — heterogeneous multi-dimensional usage

The feature can enter v1 if the design proves, before API freeze:

- all required dimensions admit atomically or none commit;
- one logical operation keeps one replay identity;
- hierarchical budgets inside one dimension compose cleanly;
- settlement/replay/expiry/lost-ACK semantics remain deterministic;
- the representation stays provider-neutral and does not turn usage enforcement into billing/pricing logic;
- built-in and third-party Store conformance can express the required transaction shape.

If a safe vector model is not ready, v1 may retain the v0.5 scalar model and introduce a later compatible or major-version extension as appropriate.

### Other open capabilities

Issues #76, #81, and #82 are not automatically excluded from v1 merely because earlier planning called them post-v1. They should enter v1 only if they are low-risk, clearly useful, and do not create a second accounting authority or weaken fail-closed behavior.

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

## v0.5 release checks

Before creating the v0.5.0 source tag/release:

1. version all five packages together to `0.5.0`;
2. move the intended post-v0.4 changes into the `0.5.0` changelog section;
3. run Node 20/22/24 normal CI;
4. run Redis, Cloudflare local/workerd, and Firestore Emulator integration checks;
5. run package tarball/content/version and clean-consumer verification;
6. verify README/roadmap/release docs describe v0.5 as the immediate release and v1 as a later scope decision;
7. create the v0.5.0 source tag/GitHub Release only after the release commit is green;
8. keep npm publication separate unless independently authorized.

## Future v1 release gate

A future v1.0 release should happen only after:

1. v0.5 stabilization/dogfood has produced enough operational confidence;
2. #83/#84 and other deliberate v1-scope candidates have been explicitly accepted or deferred;
3. long-lived public package/subpath/API names are reviewed one final time;
4. any breaking contract change judged necessary is made before the v1 tag;
5. the full package/integration matrix is green at `1.0.0`;
6. explicit v1 source-release authorization is given.

There is no requirement that v1 immediately follow v0.5, nor that every future capability be completed before v1. The stable boundary should reflect demonstrated product need and safety evidence.

## Release / npm separation

GitHub source releases and npm publication remain separate operations. npm publication is still intentionally deferred and must not happen merely because v0.5.0 or a future v1.0 source release is ready.

## Current decision

**Next source release: v0.5.0.**

**v0.5.0 readiness: GO, subject to normal release CI/packaging checks.**

**v1.0 scope/API freeze: NOT FINAL; re-evaluate after v0.5.**

**#83/#84: OPEN v1-scope candidates, not predetermined post-v1 work.**

**npm publication: still deferred and separate.**
