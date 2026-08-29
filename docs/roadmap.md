# Roadmap

[English](roadmap.md) | [日本語](roadmap.ja.md)

This roadmap protects the project's core category: **failure-safe transactional usage enforcement around MCP execution**.

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

The project should deepen correctness and production usability at that boundary rather than expand into a generic gateway, billing ledger, governance system, or workflow engine. See [Project positioning](positioning.md).

## Current baseline

**v0.10.0 is the current GitHub/source release baseline.** All five publishable package manifests are aligned at `0.10.0`, require Node.js 22+, and remain unpublished to npm.

First npm publication is a separately authorized operation tracked by #6. Source-release progress never implies registry publication.

```text
v0.6 progressive growth [RELEASED]
 -> v0.7 atomic heterogeneous vectors [RELEASED]
 -> v0.8 scalar operation reconciliation [RELEASED]
 -> v0.9 repository-wide safety hardening [RELEASED]
 -> v0.10 operational usability [RELEASED]
 -> v0.11 accounting/completion/distribution/API freeze [ACTIVE]
 -> v1.0 feature-free stable promotion
```

## Safety boundary that must not regress

Across every remaining release:

- admission comparison and reservation stay one authoritative Store transition;
- all participating budgets/dimensions reserve atomically or none do;
- pending and cost-liable expiry remain distinct, with unknown liable usage conservative;
- replay/idempotency identity remains scoped to one logical operation;
- ambiguous state-changing outcomes are not blindly retried;
- unlike scalar/vector dimensions are never collapsed into a synthetic total;
- MCP multi-round resume remains integrity-verified, binding-aware, and one-time;
- observability remains non-authoritative;
- provider durability/time/HA/lost-ACK limits remain explicit;
- entitlement, billing, pricing catalogs, provider-health policy, and financial reconciliation remain application-owned.

## Released capability line

| Release | Decision | Status |
| --- | --- | --- |
| **v0.6.0** | Optional progressive reservation growth through `UsageLease.grow()` / `ProgressiveUsageStore` | Released / adopted |
| **v0.7.0** | Optional atomic heterogeneous vector usage through `VectorUsageControl` / `VectorUsageStore` | Released / adopted |
| **v0.8.0** | Optional read-only scalar operation reconciliation through `OperationReconciliationStore` | Released / adopted |
| **v0.9.0** | Repository-wide safety hardening #116-#127 plus Firestore race blocker #143 | Released / complete |
| **v0.10.0** | Operational snapshot/runtime identity, canonical settlement diagnostics, scoped threshold/exhaustion helpers | Released / adopted |

Firestore outer retry remains restricted to definitive transaction aborts. `UNKNOWN`, `UNAVAILABLE`, `INVALID_ARGUMENT`, and other ambiguous/provider failures are not promoted into a generic retry allow-list.

## v0.11 progress completed so far

### #166 Redis renewed-lease reliability — complete

The apparent renewal failure was a test-harness race: parallel Vitest files shared one Redis database and independently used `FLUSHDB`. Redis runtime renewal remained based on Redis server `TIME`. Redis test files now run without file parallelism and the renewal proof uses wide timing margins without weakening lease semantics.

### #105 Node.js support floor — complete

The v1 supported runtime floor is **Node.js 22+**. Node 22/24 are the supported evidence matrix. Node 20 is EOL and remains only as a temporary compatibility-only check context until the protected merge policy can be migrated safely under #160.

### #157 Firestore growth-concurrency reliability — complete

The Firestore Emulator can surface `3 INVALID_ARGUMENT: Transaction is invalid or closed.` during progressive-growth contention. The Store does not blanket-retry it.

The integration gate now includes repeated diagnostic stress that distinguishes authoritative stale-cursor rejection from provider ambiguity and resolves only the exact logical increment through the existing idempotency fence. Both same-increment and distinct-increment ambiguity paths have been observed and resolved without weakening one-winner/double-commit invariants.

### #152 cost-bearing operation lifecycle — frozen on existing primitives

Provider-backed cost-bearing work does not require a new billing-specific public primitive.

The v1 composition is:

```text
application resolves trusted caller + accounting scope + pricing
  -> atomically reserve bounded count/cost exposure
  -> mark liable immediately before billable dispatch
  -> grow before any additional billable exposure
  -> renew while authoritative work/evidence remains active
  -> settle authoritative actual usage
```

The focused proof covers shared accounting scopes across different callers, atomic count + provider-cost dimensions, maximum exposure, pre-dispatch proven-no-effect release, retry pre-growth, growth denial blocking retry dispatch, conservative post-dispatch ambiguity, settlement bounds, and duplicate operation protection.

Opaque application-owned budget keys already represent a shared accounting bucket, so core does not add `subscriptionId`, `billingAccountId`, or `budgetScopeId`. Provider cost uses safe integer/fixed-scale application units. If no defensible maximum exposure or controllable pre-growth boundary exists, the application cannot claim a hard spend cap from this library.

See [Cost-bearing operations](cost-bearing-operations.md).

## Active v0.11 execution order

The remaining sequence is now:

1. **#106 persisted-state compatibility** — freeze Redis, Firestore, and Cloudflare schema/version ownership, upgrade behavior, downgrade/rollback safety, newer-schema fail-closed behavior, and operator reset/migration boundaries.
2. **#161 public API/name freeze** — decide the final settlement-outcome typing boundary; review scalar/vector parity, package names, exports/subpaths, error/status vocabulary, lifecycle terminology, and MCP Tasks/MRTR scope.
3. **#160 release-safety enforcement** — finish the required-check/ruleset policy so applicable supported Node/package/Redis/Cloudflare/Firestore evidence cannot be accidentally bypassed. Path-aware `cloudflare-safety` and `firestore-safety` checks already exist; the administrative branch-protection write remains pending because the current connector is read-only for that mutation.
4. **#24 Cloudflare real-operation boundary** — execute documented real credential rotation and finalize the honest v1 platform-limit claim. Do not burn shared Free-plan quota solely to manufacture an overload/exhaustion event.
5. **final v0.11 release evidence** — supported Node/package checks, Redis, Cloudflare workerd, Firestore Emulator, tarball/clean-consumer validation, bilingual docs, and final public-contract review all green with no unresolved v1 blocker.
6. **#6 first npm publication** — only if separately explicitly authorized, after the public contract is frozen. Registry/provenance/clean-install verification is part of that separate operation.

## v1 completion definition

v1.0 is a **stable promotion of an already completed surface**, not the release where unresolved product/accounting questions are decided.

Before v1.0:

- every material capability has an explicit adopt/defer/exclude decision;
- adopted capabilities have failure semantics, concurrency/provider evidence, packaging coverage, and bilingual documentation;
- package names, exports, lifecycle semantics, Store support claims, Node support, and MCP integration boundaries are frozen;
- cost-bearing work is mapped to the frozen accounting lifecycle without adding billing authority to core;
- persisted-state upgrade/rollback boundaries are documented and tested;
- release-critical evidence is protected by required stable safety checks or an equally strong branch policy;
- Cloudflare production claims match observed evidence;
- final source/package/provider evidence is green;
- no issue remains classified as a v1 blocker.

**v1.0 itself should add no new feature or accounting model.**

## Issue classification toward v1

| Issue | Target | Direction |
| --- | --- | --- |
| #83 progressive reservation growth | v0.6 | Adopted / released |
| #84 heterogeneous multi-dimensional usage | v0.7 | Adopted / released |
| #81 operation reconciliation/status | v0.8 | Adopted / released |
| #116-#127 repository safety hardening | v0.9 | Completed / released |
| #143 Firestore vector growth-vs-settle race | v0.9 | Completed release blocker |
| #76 / #99 / #82 operational usability | v0.10 | Completed / released |
| #166 Redis renewed-lease reliability | v0.11 | **Completed** |
| #105 Node.js support floor | v0.11 | **Completed; Node 22+** |
| #157 Firestore progressive growth concurrency | v0.11 | **Completed; diagnostic stress in gate** |
| #152 cost-bearing operation lifecycle | v0.11 | **Frozen on existing vector/growth lifecycle** |
| #106 persisted-store compatibility | v0.11 | **Active storage compatibility freeze** |
| #161 settlement/public lifecycle typing | v0.11 | **Pending public API/name freeze** |
| #160 required release-safety enforcement | v0.11 | **Workflow foundation complete; branch-policy enforcement pending** |
| #24 Cloudflare real operational evidence | v0.11 | **Pending final production evidence** |
| #6 first npm publication | separate v0.11/v1 distribution gate | **Open; explicit authorization required** |

## Release policy

- Release mechanics must not silently change accounting semantics.
- GitHub/source releases and npm publication remain independently authorized operations.
- Provider claims must not exceed observed/tested evidence.
- A GitHub/source release never implies registry publication.
- Stable provider safety checks must be enforced by merge policy before stable promotion, not merely emitted by Actions.

See [Release policy](releasing.md), [v1.0 readiness review](v1-readiness.md), [Cost-bearing operations](cost-bearing-operations.md), and provider-specific documentation before production deployment.
