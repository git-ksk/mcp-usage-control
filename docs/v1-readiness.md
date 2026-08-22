# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

This document records evidence accumulated toward a future v1.0. It is a **readiness assessment**, not a release instruction or an immutable API-freeze decision.

No v1.0 tag, GitHub Release, or npm publication is authorized by this document.

## Current status

**v0.9.0 is the latest GitHub/source release baseline.** It was released on 2026-08-22 from tested commit `e2a8f8e5dcf725a2c085faa3170a8e38e91504d2` after the repository-audit safety set #116-#127 and Firestore release blocker #143 were closed.

All five publishable package manifests are aligned at `0.9.0`. The packages remain **unpublished to npm**. First registry publication remains separately tracked by #6 and requires explicit authorization independent from source releases.

The active decision gate is now **v0.10.0 / #76 + #82 + #99 operational usability and dogfood diagnostics**. The final pre-v1 gate is **v0.11.0 / #24 + #6 + #105 + #106 completion/distribution/API freeze**, followed by feature-free v1.0 promotion.

## Verdict

**The core accounting model remains a strong v1 candidate, but v1.0 is not ready to promote yet.**

What is already proven:

- scalar atomic admission/reservation and conservative liability/expiry semantics;
- optional progressive scalar growth (#83), adopted in v0.6;
- optional atomic heterogeneous vectors (#84), adopted in v0.7;
- optional read-only scalar operation reconciliation (#81), adopted in v0.8;
- repository-wide safety-hardening interactions #116-#127, completed in v0.9;
- Firestore vector growth-vs-settle release blocker #143 resolved without weakening the race invariant;
- Node 20/22/24 package and clean-consumer validation;
- Redis, Cloudflare local workerd, and Firestore Emulator provider evidence;
- fail-closed treatment of ambiguous state-changing outcomes;
- MCP multi-round one-time/binding-aware resume semantics;
- non-authoritative observability boundary.

What still blocks v1 promotion:

- bounded operational usability and diagnostics (#76, #82, #99);
- final Cloudflare real-operation boundary (#24);
- separately authorized first npm publication and registry/provenance dogfood (#6);
- explicit v1 Node.js support floor (#105);
- persisted-store migration/rollback/newer-schema compatibility contract (#106);
- final public package/export/API terminology freeze;
- final MCP Tasks / MRTR scope decisions;
- final full production/distribution evidence with no unresolved v1 blocker.

## Stable accounting invariants

These must remain true through v0.10, v0.11, and v1.0:

1. Admission comparison and reservation are one authoritative Store operation.
2. Every participating budget/dimension required for an admission commits atomically or none commit.
3. Replay identity remains `(tenantId, principal.id, tool, operationId)` for one logical operation.
4. Metered execution is preceded by explicit liability.
5. Renewal changes lease duration, not reserved capacity.
6. Pending expiry may release capacity; liable unknown usage remains conservative.
7. Settlement is bounded by successfully reserved capacity.
8. Ambiguous state-changing outcomes are not blindly retried.
9. Scalar and vector paths never collapse unlike dimensions into one synthetic total.
10. MCP multi-round resume is integrity-verified, binding-aware, and one-time.
11. Resume never creates a second usage reservation.
12. Business-operation replay/result replay remains application-owned.
13. Observability cannot change enforcement state.
14. Provider durability/time/HA/lost-ACK limits remain explicit.

## Adopted v1 capability candidates

### Progressive reservation growth (#83) — adopted in v0.6

`UsageLease.grow()` / optional `ProgressiveUsageStore` provide bounded incremental capacity without making growth mandatory for third-party Stores. The proof covers atomic all-budget growth, stable increment identity, lost-ACK replay fencing, terminal-state rejection, inherited pending/liable semantics, and settlement bounded by total committed capacity.

### Heterogeneous multi-dimensional usage (#84) — adopted in v0.7

`VectorUsageControl` / optional `VectorUsageStore` keep dimensions semantically distinct while preserving one logical replay identity and one atomic reservation-wide transaction domain. Provider evidence covers Memory, Redis, Cloudflare Durable Objects, and Firestore.

### Scalar operation reconciliation (#81) — adopted in v0.8

Optional `OperationReconciliationStore` provides read-only `absent` / `active` / `expired` / `settled` status. Backend/transport failure, corrupt state, unsupported mode, and trusted-input mismatch remain indeterminate/fail closed rather than becoming `absent`. Reconciliation does not reserve/release, mark liability, renew, settle, or rewrite replay state.

## v0.9.0 safety-hardening evidence

The v0.9 audit focused on capability intersections rather than new product surface. It closed #116-#127 and added explicit regression coverage across retention/growth, flow-store/growth, recovery/reconciliation, maintenance/vector, authorization, protocol validation, arithmetic bounds, and runtime identity validation.

Firestore release blocker #143 was closed with these semantics preserved:

- settlement in `vector-growth-vs-settle-race` must complete;
- if growth commits first, settlement must observe the grown reservation;
- bounded outer retry applies only to definitive transaction aborts: gRPC `ABORTED` (`10`) and HTTP `409`;
- `UNKNOWN`, `UNAVAILABLE`, `INVALID_ARGUMENT`, and other ambiguous/provider failures are not added to the adapter outer retry allow-list;
- no-op vector settlement avoids unnecessary budget reads/writes to reduce contention without changing accounting semantics.

The normal release/package gate and provider integration evidence were green before the v0.9 source release. The GitHub/source release succeeded. npm publication did not complete and is intentionally deferred under #6.

## v0.10 readiness gate

v0.10 should add operational usability without creating a second ledger or authority.

Acceptance direction for #76/#82/#99:

- expose only bounded/scoped authoritative values where needed;
- keep lifecycle/threshold helpers non-authoritative;
- no PII or uncontrolled high-cardinality labels by default;
- distinguish invalid integration input from service/store unavailability;
- normalize settlement outcome vocabulary without weakening settlement validation;
- preserve vector dimension meaning;
- helper/observer failure cannot alter enforcement.

## v0.11 final completion gate

Before v1 stable promotion, v0.11 must close or explicitly scope:

- #24 Cloudflare real-operation evidence;
- #6 first npm publication, only after separate explicit authorization, including registry ownership, provenance, package contents, and clean-registry consumer verification;
- #105 supported Node.js floor;
- #106 persisted-store upgrade/migration/rollback/newer-schema behavior;
- package names, exports/subpaths, errors/status vocabulary, and public lifecycle semantics;
- MCP Tasks adapter decision based on upstream stability;
- MRTR scope decision, retaining shared/durable compare-and-consume unless an alternative has equivalent proof;
- final integration/package/deployed/manual evidence.

## Distribution boundary

The current source-release baseline is `v0.9.0` and the five manifests are `0.9.0`.

**npm publication remains a separate operation and has not been completed.** A source release does not imply registry publication. Issue #6 remains open until first publication is actually desired, explicitly authorized, completed, and verified.

## v1 promotion rule

v1.0 should contain **no new feature or accounting model**. Promotion is allowed only when the v0.11 completion criteria are satisfied, the public surface is frozen, final evidence is green, and there is no unresolved issue still classified as a v1 blocker.

See [Roadmap](roadmap.md), [Release policy](releasing.md), and provider-specific documentation for the current support boundaries.
