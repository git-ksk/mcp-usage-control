# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

This document records evidence accumulated toward a future v1.0. It is a **readiness assessment**, not a release instruction or an immutable API-freeze decision.

No v1.0 tag, GitHub Release, or npm publication is authorized by this document.

## Current status

**v0.10.0 is the current GitHub/source release baseline.** All five publishable package manifests are aligned at `0.10.0`.

The packages remain **unpublished to npm**. First registry publication remains separately tracked by #6 and requires explicit authorization independent from source releases.

The active decision gate is now **v0.11.0 / #152 -> #157 -> #105 + #106 -> #24 -> #6 accounting-contract, reliability, completion/distribution/API freeze**, followed by feature-free v1.0 promotion.

## Verdict

**The core accounting model remains a strong v1 candidate, and v0.10 closes the operational-usability gate. v1.0 is still not ready to promote.**

Already proven/adopted:

- scalar atomic admission/reservation and conservative liability/expiry semantics;
- optional progressive scalar growth (#83), adopted in v0.6;
- optional atomic heterogeneous vectors (#84), adopted in v0.7;
- optional read-only scalar operation reconciliation (#81), adopted in v0.8;
- repository-wide safety-hardening interactions #116-#127, completed in v0.9;
- Firestore vector growth-vs-settle blocker #143 resolved without weakening the race invariant;
- bounded operational snapshot/runtime identity (#76), completed in v0.10;
- canonical settlement outcome normalization and distinguishable bounded diagnostics (#99), completed in v0.10;
- scoped threshold/exhaustion helpers (#82), completed in v0.10;
- Node 20/22/24 package and clean-consumer validation;
- Redis, Cloudflare local workerd, and Firestore Emulator provider evidence;
- fail-closed treatment of ambiguous state-changing outcomes;
- MCP multi-round one-time/binding-aware resume semantics;
- non-authoritative observability boundary.

What still blocks v1 promotion:

- explicit cost-bearing operation lifecycle mapping and shared accounting-scope proof (#152), including maximum exposure, retry cost, variable-cost growth boundaries, and delayed provider usage evidence;
- Firestore progressive growth-concurrency reliability classification and repeated evidence (#157);
- explicit v1 Node.js support floor (#105);
- persisted-store migration/rollback/newer-schema compatibility contract (#106);
- final Cloudflare real-operation boundary (#24);
- separately authorized first npm publication and registry/provenance dogfood (#6);
- final public package/export/API terminology and settlement-outcome typing freeze;
- final MCP Tasks / MRTR scope decisions;
- a required release-safety gate, or an equally strong branch-protection policy, covering applicable release-critical CI/provider evidence;
- final full production/distribution evidence with no unresolved v1 blocker.

## Stable accounting invariants

These must remain true through v0.11 and v1.0:

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
15. Entitlement, subscription, pricing catalog, and provider-health policy remain application-owned rather than becoming a second authority inside MCPUsage.
16. Hard provider-spend enforcement is claimed only when maximum billable exposure is reserved before dispatch or additional exposure is atomically grown before further billable work.

## Adopted v1 capability candidates

### Progressive reservation growth (#83) — adopted in v0.6

`UsageLease.grow()` / optional `ProgressiveUsageStore` provide bounded incremental capacity without making growth mandatory for third-party Stores. Proof covers atomic all-budget growth, stable increment identity, lost-ACK replay fencing, terminal-state rejection, inherited pending/liable semantics, and settlement bounded by total committed capacity.

### Heterogeneous multi-dimensional usage (#84) — adopted in v0.7

`VectorUsageControl` / optional `VectorUsageStore` keep dimensions semantically distinct while preserving one logical replay identity and one atomic reservation-wide transaction domain. Provider evidence covers Memory, Redis, Cloudflare Durable Objects, and Firestore.

### Scalar operation reconciliation (#81) — adopted in v0.8

Optional `OperationReconciliationStore` provides read-only `absent` / `active` / `expired` / `settled` status. Backend/transport failure, corrupt state, unsupported mode, and trusted-input mismatch remain indeterminate/fail closed rather than becoming `absent`. Reconciliation does not reserve/release, mark liability, renew, settle, or rewrite replay state.

### Operational usability (#76/#99/#82) — adopted in v0.10

v0.10 adds explicit core subpaths for bounded operational visibility without creating a second accounting authority:

- `mcp-usage-control/operational` provides process-local lifecycle counters, bounded static runtime identity, and explicit scoped quota projection;
- `mcp-usage-control/settlement-outcomes` defines the canonical outcome vocabulary, compatibility aliases, and `invalid_settlement_outcome` diagnostics without retaining raw invalid input;
- `mcp-usage-control/thresholds` provides pure evaluation/crossing helpers over an explicitly selected quota scope.

Important non-claims are part of the contract: active-reservation counts are not inferred from incomplete/replayable events, window/reset state remains application-owned, notification delivery is outside core, and observer/diagnostic failure cannot change enforcement.

The release/package gate verifies the new public subpaths in tarball contents and clean-consumer imports.

A post-v0.10 audit found that Firestore recovery events used a provider-specific observer type while the common recovery event vocabulary omitted `firestore`. This is a telemetry/type-integration defect, not an accounting-state defect. v0.11 must keep provider-neutral recovery observability type-compatible across all built-in Stores.

## v0.9 safety-hardening evidence carried forward

The v0.9 audit focused on capability intersections rather than new product surface. It closed #116-#127 and Firestore blocker #143 while preserving scalar/vector accounting, replay, liability, expiry/recovery, and fail-closed contracts.

Firestore outer retry remains limited to definitive transaction aborts: gRPC `ABORTED` (`10`) and HTTP `409`. Ambiguous/provider failures such as `UNKNOWN`, `UNAVAILABLE`, and `INVALID_ARGUMENT` are not added to that retry allow-list.

## v0.11 final completion gate

Before v1 stable promotion, v0.11 must close or explicitly scope, in priority order:

1. **#152 cost-bearing operation reservation lifecycle** — prove the frozen reserve/liability/grow/settlement contract is sufficient for provider-backed billable work, shared accounting scopes, retry/idempotency, conservative ambiguous outcomes, proven-no-effect release, bounded maximum exposure, distinct count/cost dimensions, and delayed final provider usage evidence; add new surface only if the current model is insufficient.
2. **#157 Firestore progressive growth-concurrency reliability** — classify the observed Emulator `Transaction is invalid or closed` failure and obtain repeated evidence without broadening retry of ambiguous state-changing failures or weakening growth-concurrency invariants.
3. **#105 supported Node.js floor** and **#106 persisted-store compatibility** — freeze runtime and state compatibility guarantees.
4. **#24 Cloudflare real-operation evidence** — complete credential rotation and the final honest production-evidence boundary.
5. **#6 first npm publication** — only after separate explicit authorization and after the public contract is frozen.
6. package names, exports/subpaths, errors/status vocabulary, settlement outcome typing, public lifecycle semantics, MCP Tasks/MRTR decisions, release-safety branch protection, and final integration/package/deployed/manual evidence.

## Distribution boundary

The current source-release baseline is `v0.10.0` and the five manifests are `0.10.0`.

**npm publication remains a separate operation and has not been completed.** A source release does not imply registry publication. Issue #6 remains open until first publication is actually desired, explicitly authorized, completed, and verified.

## v1 promotion rule

v1.0 should contain **no new feature or accounting model**. Promotion is allowed only when the v0.11 completion criteria are satisfied, the public surface is frozen, final evidence is green, release-critical CI/provider evidence is protected from accidental bypass, and there is no unresolved issue still classified as a v1 blocker.

See [Roadmap](roadmap.md), [Release policy](releasing.md), and provider-specific documentation for the current support boundaries.
