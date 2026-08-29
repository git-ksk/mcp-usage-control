# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

This document records evidence accumulated toward a future v1.0. It is a **readiness assessment**, not a release instruction or an authorization to publish packages.

No v1.0 tag, GitHub Release, or npm publication is authorized by this document.

## Current status

**v0.12.0 is the current GitHub/source release baseline.** The v0.13 preparation branch aligns all five publishable manifests at `0.13.0` and requires Node.js 22 or later.

The packages remain **unpublished to npm**. First registry publication is separately tracked by #6 and requires explicit authorization independent from source releases.

The v0.11 freeze line has now resolved the accounting/reliability/runtime/storage/API/governance tranche:

- #166 Redis renewed-lease reliability was traced to cross-file `FLUSHDB` interference and fixed without changing Redis runtime semantics;
- #105 froze the supported Node.js floor at **22+**; #197 retires Node 20 from required CI so Node 22/24 are the only supported evidence;
- #157 classified Firestore Emulator progressive-growth contention and added repeated diagnostic stress without adding `INVALID_ARGUMENT` to Store runtime retry;
- #152 froze provider-backed cost-bearing work onto the existing vector reserve/liability/grow/renew/settle contract;
- #106 froze Redis/Firestore/Cloudflare persisted-state upgrade, rollback, future-schema fail-closed, and fresh-domain reset boundaries;
- #161 froze the v1 package/lifecycle/status/error vocabulary and made MCP settlement alias normalization explicit;
- #160 made the already-protected `test (22)` context an aggregate release-safety gate for applicable Node/Redis/package/Cloudflare/Firestore evidence;
- #24 completed the real Monokura Cloudflare credential rotation, new-caller proof, and rotated-out credential rejection while preserving the existing accounting identity. Genuine Workers platform-limit exhaustion/overload was not naturally observed and is not claimed as deployed evidence.

The v0.11 completion tranche is closed. Issue #6 remains a separate publication gate and runs only when explicitly authorized; it is not implicitly authorized by a source release.

## Verdict

**The accounting model remains frozen, but the final v1 audit identified a bounded v0.13 blocker-closure tranche that must be green before stable promotion.**

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

```text
application-owned entitlement / accounting scope / pricing
  -> atomic vector reserve of bounded maximum exposure
  -> mark liable immediately before billable dispatch
  -> grow before any additional billable exposure
  -> renew while authoritative work/evidence remains active
  -> settle authoritative actual usage
```

Focused proof establishes shared accounting scopes, separate count/provider-cost dimensions, safe integer/fixed-scale cost units, bounded settlement, proven-no-effect release, retry pre-growth, growth-denial stop, conservative liable ambiguity, and duplicate-operation protection.

See [Cost-bearing operations](cost-bearing-operations.md).

## v0.11 reliability / compatibility / API evidence

### Redis renewal reliability (#166) — complete

The observed renewed-lease failure was caused by parallel Vitest files sharing one Redis database while independently calling `FLUSHDB`. Redis runtime renewal continued to use Redis server `TIME`; the test harness now serializes Redis test files and uses a wide timing proof.

### Firestore progressive growth contention (#157) — complete

The Firestore Emulator can return `3 INVALID_ARGUMENT: Transaction is invalid or closed.` during identical-increment and distinct-increment contention. Runtime retry remains limited to definitive transaction aborts. Diagnostic stress instead proves authoritative resolution through existing idempotency fences and is part of the integration gate.

### Node.js support floor (#105) — complete

All five public package manifests declare `engines.node >=22`. Node.js 22 and 24 are the supported v1 runtime evidence. Node 20 is EOL and compatibility-only.

### Persisted-state compatibility (#106) — complete

Redis new state is marked `schemaVersion: 1`, exact legacy unversioned state remains readable in place, and unsupported future versions fail closed before mutation. Firestore keeps versioned reservation/budget documents with unknown-version rejection. Cloudflare Durable Objects keep explicit SQLite migrations and future-schema rejection. Upgrade/rollback/reset boundaries are documented per provider.

### Public API/name freeze (#161) — complete

Store-facing/direct lease settlement outcomes intentionally remain extensible strings; the canonical portable vocabulary stays in `mcp-usage-control/settlement-outcomes`. The built-in MCP adapter normalizes compatibility aliases before authoritative settlement. Package names, current subpaths, lifecycle/status/error terms, scalar/vector parity, and MCP multi-round scope are frozen.

### Aggregate release-safety enforcement (#160) — complete

`test (22)` is the protected aggregate release-safety gate. It requires Node 22/24, Redis, package/tarball/clean-consumer, peer-compatibility, and applicable Cloudflare workerd / Firestore Emulator evidence. Node 20 is no longer a required context. Provider skips are accepted only when the path classifier marks them non-applicable, and docs-only changes resolve required contexts through a lightweight path without deadlock.

### Real Cloudflare operational evidence (#24) — complete

The documented zero-downtime rotation was executed against the real Monokura deployment. New and old credentials both worked during overlap; Cloud Run moved to the new explicit Secret Manager version; a real `list_boards` caller succeeded on the new revision; and the retired credential was rejected afterward. The Durable Object/accounting identity remained unchanged and no Firestore quota fallback was enabled.

A genuine Workers Free-plan exhaustion/platform-overload event did not occur naturally. The project therefore does not claim deployed empirical evidence for every platform-limit condition; that boundary remains explicit rather than being manufactured by burning shared quota.

## v1 promotion status

v0.11 established the accounting/runtime/storage/API freeze, and v0.12 completes the bounded #177-#184 hardening checkpoint: exact-SHA release provenance, validated release artifacts, supply-chain maintenance, incident response, current operator docs, competitive adopt/defer decisions, additive non-authoritative quota-window UX projection, and reproducible provider performance/cost evidence. The frozen accounting lifecycle and persisted Store contract remain unchanged.

v1.0 remains a feature-free stable promotion over that hardened surface.

## npm distribution boundary

The source-release baseline is `v0.12.0`. npm publication is a separate operation and has not occurred.

Issue #6 remains open until first publication is actually desired, **separately explicitly authorized**, completed, and verified for package ownership/availability, provenance, registry metadata, package contents, and clean-consumer installation.

A source release never implicitly authorizes registry publication.

## v1 promotion rule

v1.0 should introduce **no new accounting model**. The bounded v0.13 blocker-closure tranche is the final corrective checkpoint over the frozen model; stable promotion is contingent on v0.13 release evidence being green. npm publication remains independently authorized under #6.

See [Roadmap](roadmap.md), [Release policy](releasing.md), [Cost-bearing operations](cost-bearing-operations.md), [Persisted-state compatibility](persisted-state-compatibility.md), [v1 public API freeze](v1-public-api-freeze.md), and provider-specific documentation for the current support boundaries.


## v0.13 final blocker closure

The final audit tracks #191-#198: authoritative multi-round flow expiry, standalone shipped docs, safe Redis/Firestore historical-budget retirement, lease-renewal uncertainty signaling, initial vector-reserve reconciliation, provider-neutral input bounds, Node 20 CI retirement, and minimum/current peer-dependency compatibility. These changes harden recovery and operations around the frozen accounting model rather than introducing a new charging model. Issue #6 remains independently authorized.
