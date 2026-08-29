# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

This document records evidence accumulated toward a future v1.0. It is a **readiness assessment**, not a release instruction or an authorization to publish packages.

No v1.0 tag, GitHub Release, or npm publication is authorized by this document.

## Current status

**v0.10.0 is the current GitHub/source release baseline.** All five publishable package manifests remain aligned at `0.10.0` and require Node.js 22 or later.

The packages remain **unpublished to npm**. First registry publication is separately tracked by #6 and requires explicit authorization independent from source releases.

The v0.11 completion line has now resolved the initial accounting/reliability/runtime tranche:

- #166 Redis renewed-lease reliability was traced to cross-file `FLUSHDB` test interference and fixed without changing Redis runtime semantics;
- #105 froze the supported Node.js floor at **22+**; Node 22/24 are supported evidence and Node 20 is compatibility-only while its required check context remains protected;
- #157 classified Firestore Emulator progressive-growth contention and added repeated diagnostic stress without adding `INVALID_ARGUMENT` to Store runtime retry;
- #152 freezes provider-backed cost-bearing work onto the existing vector reserve/liability/grow/renew/settle contract rather than adding a billing-specific public primitive.

The active remaining v0.11 sequence is **#106 persisted-state compatibility -> #160 release-safety enforcement + #161 public API/name freeze -> #24 final Cloudflare evidence -> final v0.11 release evidence**. Issue #6 is a separate publication gate and runs only when explicitly authorized.

## Verdict

**The accounting model remains a strong v1 candidate, and the main semantic/runtime reliability decisions are now frozen. v1.0 is not ready to promote until the remaining compatibility, API, production-evidence, and merge-governance gates are closed.**

## Stable accounting invariants

These must remain true through v0.11 and v1.0:

1. Admission comparison and reservation are one authoritative Store operation.
2. Every participating budget/dimension required for admission commits atomically or none commit.
3. Replay identity remains `(tenantId, principal.id, tool, operationId)` for one logical operation.
4. Metered execution is preceded by explicit liability.
5. Renewal changes lease duration, not reserved capacity.
6. Pending expiry may release capacity; liable unknown usage remains conservative.
7. Settlement is bounded by successfully reserved capacity.
8. Ambiguous state-changing outcomes are not blindly retried.
9. Scalar/vector accounting never collapses unlike dimensions into one synthetic total.
10. MCP multi-round resume remains integrity-verified, binding-aware, and one-time.
11. Resume never creates a second usage reservation.
12. Business-operation idempotency/result replay remains application-owned.
13. Observability cannot change enforcement state.
14. Provider durability/time/HA/lost-ACK limits remain explicit.
15. Entitlement, subscription, pricing catalogs, currency conversion, provider-health policy, and financial reconciliation remain application-owned.
16. Hard provider-spend enforcement is claimed only when maximum billable exposure is reserved before dispatch or additional exposure is atomically grown before further billable work.

## Adopted v1 capability candidates

### Progressive reservation growth (#83) — adopted in v0.6

`UsageLease.grow()` and optional `ProgressiveUsageStore` provide bounded incremental capacity. Proof covers atomic all-budget growth, stable increment identity, lost-ACK replay fencing, pending/liable semantics, terminal-state rejection, and settlement bounded by total committed capacity.

### Heterogeneous multi-dimensional usage (#84) — adopted in v0.7

`VectorUsageControl` and optional `VectorUsageStore` keep unlike dimensions semantically distinct while preserving one logical operation identity and one atomic reservation-wide transaction domain. Memory, Redis, Cloudflare Durable Objects, and Firestore carry provider evidence for the vector model.

### Scalar operation reconciliation (#81) — adopted in v0.8

Optional `OperationReconciliationStore` provides read-only `absent` / `active` / `expired` / `settled` status. Backend failure, corrupt state, unsupported mode, and trusted-input mismatch remain indeterminate/fail closed rather than becoming `absent`.

### Operational usability (#76/#99/#82) — adopted in v0.10

The v0.10 public subpaths remain non-authoritative:

- `mcp-usage-control/operational` — bounded process-local lifecycle counters, runtime identity, and explicitly scoped quota projection;
- `mcp-usage-control/settlement-outcomes` — canonical settlement vocabulary, compatibility aliases, and bounded invalid-outcome diagnostics;
- `mcp-usage-control/thresholds` — pure threshold evaluation/crossing helpers over an application-selected quota scope.

Observer/diagnostic failure cannot alter admission, liability, renewal, growth, or settlement.

### Cost-bearing provider work (#152) — frozen in v0.11

The existing public surface is sufficient; v0.11 does **not** add a billing-specific accounting primitive.

The adopted composition is:

```text
application-owned entitlement / accounting scope / pricing
  -> atomic vector reserve of bounded maximum exposure
  -> mark liable immediately before billable dispatch
  -> grow before any additional billable exposure
  -> renew while authoritative work/evidence remains active
  -> settle authoritative actual usage
```

Focused proof establishes:

- multiple caller principals can consume one application-selected shared accounting scope through opaque budget keys;
- count quota and provider-cost budget remain separate vector dimensions;
- provider cost uses application-defined safe integer/fixed-scale units;
- settlement cannot exceed successfully reserved exposure and releases unused capacity;
- proven pre-dispatch no-effect can settle to zero;
- a billable retry is dispatched only after its additional exposure is successfully grown;
- growth denial prevents that retry;
- post-dispatch/liable ambiguity retains exposure conservatively;
- stable logical operation identity prevents duplicate reservation.

If a provider can accrue unbounded cost without a controllable pre-growth boundary, the application cannot honestly claim a hard spend cap from this library. Delayed provider usage is supported while the lease can be authoritatively retained/renewed, or when the initial reservation already covers a defensible maximum. Durable post-hoc financial reconciliation remains outside core.

See [Cost-bearing operations](cost-bearing-operations.md).

## v0.11 reliability and runtime evidence

### Redis renewal reliability (#166) — complete

The observed renewed-lease failure was caused by parallel Vitest files sharing one Redis database while independently calling `FLUSHDB`. Redis runtime renewal continued to use Redis server `TIME`; the test harness now serializes Redis test files and uses a wide timing proof. Node 20/22/24 evidence passed after the fix.

### Firestore progressive growth contention (#157) — complete

The Firestore Emulator can return `3 INVALID_ARGUMENT: Transaction is invalid or closed.` during both identical-increment and distinct-increment contention.

The runtime retry allow-list remains limited to definitive transaction aborts. `INVALID_ARGUMENT` is **not** blanket-retried.

Diagnostic stress instead proves authoritative resolution through the existing idempotency fences:

- identical increment ambiguity + an observed winner -> exact replay converges to `accepted + replayed` with the committed reserved total;
- distinct stale-cursor loser ambiguity -> exact replay converges to authoritative `UsageStateError`;
- a distinct replay that unexpectedly commits still fails the test as a possible double-commit invariant violation.

Repeated 24-iteration Emulator runs passed while actually exercising these ambiguity-resolution paths. The stress is now part of the Firestore integration gate.

### Node.js support floor (#105) — complete

All five public package manifests declare `engines.node >=22`. Node.js 22 and 24 are the supported v1 runtime evidence. Node 20 is EOL and is not a supported v1 runtime; its CI context remains temporarily as compatibility-only evidence until #160 can migrate the currently protected required-check policy safely.

## What still blocks v1 promotion

1. **#106 persisted-store compatibility** — freeze Redis, Firestore, and Cloudflare schema/version ownership, upgrade behavior, rollback safety, newer-schema fail-closed behavior, and operator reset/migration boundaries.
2. **#161 public API/name freeze** — decide the final settlement outcome typing boundary and review package names, exports/subpaths, errors/status vocabulary, lifecycle terminology, scalar/vector parity, and MCP Tasks/MRTR scope.
3. **#160 release-safety enforcement** — stable path-aware provider safety checks exist, but the final required-check/ruleset policy must prevent applicable release-critical evidence from being bypassed. The current connector cannot mutate branch protection, so that administrative step remains explicit.
4. **#24 Cloudflare real-operation evidence** — execute real credential rotation and finalize the honest v1 production claim. A naturally occurring platform-limit event may be recorded, but shared quota must not be intentionally burned merely to manufacture one.
5. **Final v0.11 release evidence** — supported Node/package checks, Redis, Cloudflare workerd, Firestore Emulator, package tarballs/clean consumer, bilingual docs, and the final public contract must all be green with no unresolved v1 blocker.

## npm distribution boundary

The source-release baseline remains `v0.10.0` until v0.11 is cut. npm publication is a separate operation and has not occurred.

Issue #6 remains open until first publication is actually desired, **separately explicitly authorized**, completed, and verified for package ownership/availability, provenance, registry metadata, package contents, and clean-consumer installation.

A source release never implicitly authorizes registry publication.

## v1 promotion rule

v1.0 should contain **no new feature or accounting model**. Promotion is allowed only after v0.11 closes the remaining compatibility/API/production/governance gates, the public surface is frozen, release-critical evidence is protected from accidental bypass, final evidence is green, and no issue remains classified as a v1 blocker.

See [Roadmap](roadmap.md), [Release policy](releasing.md), [Cost-bearing operations](cost-bearing-operations.md), and provider-specific documentation for the current support boundaries.
