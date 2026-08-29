# Roadmap

[English](roadmap.md) | [日本語](roadmap.ja.md)

This roadmap protects the project's core category: **failure-safe transactional usage enforcement around MCP execution**.

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

The project should deepen correctness and production usability at that boundary rather than expand into a generic gateway, billing ledger, governance system, or workflow engine. See [Project positioning](positioning.md) and the maintained [Competitive capability map](competitive-capabilities.md).

## Current baseline

**v0.11.0 is the current GitHub/source release baseline.** All five publishable package manifests are aligned at `0.11.0`, require Node.js 22+, and remain unpublished to npm.

First npm publication is a separately authorized operation tracked by #6. Source-release progress never implies registry publication.

```text
v0.6 progressive growth [RELEASED]
 -> v0.7 atomic heterogeneous vectors [RELEASED]
 -> v0.8 scalar operation reconciliation [RELEASED]
 -> v0.9 repository-wide safety hardening [RELEASED]
 -> v0.10 operational usability [RELEASED]
 -> v0.11 accounting/completion/API/release-safety freeze [RELEASED]
 -> v0.12 product/operations hardening [IN PROGRESS]
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
| **v0.11.0** | Pre-v1 accounting/runtime/storage/API freeze, aggregate release-safety gate, real Cloudflare rotation evidence | Released / complete |

Firestore outer retry remains restricted to definitive transaction aborts. `UNKNOWN`, `UNAVAILABLE`, `INVALID_ARGUMENT`, and other ambiguous/provider failures are not promoted into a generic retry allow-list.

## v0.11 progress completed so far

### #166 Redis renewed-lease reliability — complete

The apparent renewal failure was a test-harness race: parallel Vitest files shared one Redis database and independently used `FLUSHDB`. Redis runtime renewal remained based on Redis server `TIME`. Redis test files now run without file parallelism and the renewal proof uses wide timing margins without weakening lease semantics.

### #105 Node.js support floor — complete

The v1 supported runtime floor is **Node.js 22+**. Node 22/24 are the supported evidence matrix. Node 20 is EOL and remains only as a compatibility-only protected context.

### #157 Firestore growth-concurrency reliability — complete

The Firestore Emulator can surface `3 INVALID_ARGUMENT: Transaction is invalid or closed.` during progressive-growth contention. The Store does not blanket-retry it.

The integration gate includes repeated diagnostic stress that distinguishes authoritative stale-cursor rejection from provider ambiguity and resolves only the exact logical increment through the existing idempotency fence. Both same-increment and distinct-increment ambiguity paths have been observed and resolved without weakening one-winner/double-commit invariants.

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

### #106 persisted-state compatibility — complete

The durable-provider compatibility boundary is frozen before v1.

- Redis writes `schemaVersion: 1` for new reservation state, continues to read exact pre-v1 unversioned records in place, and rejects unsupported future versions before mutation.
- Firestore keeps explicit `schemaVersion: 1` reservation/budget documents and rejects unknown versions.
- Cloudflare Durable Objects keep explicit SQLite schema migrations through v3 and reject future schema versions.
- provider-specific upgrade/rollback safety, backup/restore expectations, and fresh accounting-domain resets are documented in English/Japanese.

See [Persisted-state compatibility](persisted-state-compatibility.md).

### #161 public API/name freeze — complete

The v1 public vocabulary is frozen without introducing an unnecessary Store migration.

- direct scalar/vector Store and lease settlement outcomes remain intentionally extensible `string` values;
- portable canonical classification remains available through `mcp-usage-control/settlement-outcomes`;
- the built-in MCP adapter normalizes compatibility aliases before authoritative settlement;
- package names, current public subpaths, lifecycle/status/error vocabulary, scalar/vector parity, and MCP multi-round naming/scope are frozen.

See [v1 public API freeze](v1-public-api-freeze.md).

### #160 aggregate release-safety enforcement — complete

The existing protected context names were preserved while strengthening their semantics.

- `test (20)` remains the legacy compatibility required context and is not v1 support evidence.
- `test (22)` is now the aggregate release-safety required context.
- applicable Node/Redis/package/tarball/clean-consumer, Cloudflare workerd, and Firestore Emulator failures propagate into `test (22)`.
- provider work is skipped only when the path classifier marks it non-applicable.
- docs-only changes use a lightweight path and still resolve the protected contexts without deadlock.

This closes the earlier governance gap without requiring an administrative branch-protection context rename.

### #24 Cloudflare real operational evidence — complete

The real Monokura dogfood deployment completed the documented zero-downtime credential rotation. The overlap window accepted both credentials, the Cloud Run caller moved to the new Secret Manager version, a real `list_boards` call succeeded on the new revision, and the rotated-out credential was rejected after retirement. The existing Durable Object/accounting identity remained unchanged and no Firestore fallback was enabled.

No genuine Workers Free-plan exhaustion/platform-overload event occurred naturally. Shared quota was not intentionally burned to manufacture one, so the v1 Cloudflare claim stays limited to the deployed behavior actually observed plus the existing local/workerd synthetic 429/503 fail-closed evidence.

## Current execution order

The v0.11 completion tranche is closed. A post-release product audit opened one bounded **v0.12 product/operations hardening** tranche (#177-#184) before v1. It may add only additive operational/developer helpers that do not redefine the frozen accounting lifecycle or persisted Store contract; #183 fits the explicit additive-helper allowance in the v1 API freeze. Release provenance, incident response, dependency maintenance, stale docs, competitive decisions, and provider benchmark evidence are hardened in the same tranche.

After v0.12 is released and these issues are closed, **v1.0 remains a feature-free stable promotion over the v0.12 surface**. Issue #6 remains an independent npm-distribution gate and may run only after separate explicit authorization; source-release progress does not authorize registry publication.

## v1 completion definition

v1.0 is a **stable promotion of an already completed surface**, not the release where unresolved product/accounting questions are decided.

Before v1.0:

- every material capability has an explicit adopt/defer/exclude decision;
- adopted capabilities have failure semantics, concurrency/provider evidence, packaging coverage, and bilingual documentation;
- package names, exports, lifecycle semantics, Store support claims, Node support, and MCP integration boundaries are frozen;
- cost-bearing work is mapped to the frozen accounting lifecycle without adding billing authority to core;
- persisted-state upgrade/rollback boundaries are documented and tested;
- release-critical evidence is protected by the aggregate required release-safety gate;
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
| #106 persisted-store compatibility | v0.11 | **Completed; provider compatibility contract frozen** |
| #161 settlement/public lifecycle typing | v0.11 | **Completed; public API/name freeze** |
| #160 required release-safety enforcement | v0.11 | **Completed; aggregate `test (22)` gate** |
| #24 Cloudflare real operational evidence | v0.11 | **Completed; real rotation/caller/rejection proof, platform-limit non-observation explicitly bounded** |
| #177 / #178 release provenance + validated artifacts | v0.12 | **In progress; no accounting-semantic change** |
| #179 dependency/action supply-chain maintenance | v0.12 | **In progress** |
| #180 known-bad release/hotfix runbook | v0.12 | **In progress** |
| #181 current operator-doc baseline cleanup | v0.12 | **In progress** |
| #182 maintained competitive capability decisions | v0.12 | **In progress; positioning guardrail** |
| #183 safe quota-window/reset UX projection | v0.12 | **In progress; additive non-authoritative helper** |
| #184 provider benchmark/cost-profile harness | v0.12 | **In progress; non-blocking performance evidence** |
| #6 first npm publication | separate v0.11/v1 distribution gate | **Open; explicit authorization required** |

## Release policy

- Release mechanics must not silently change accounting semantics.
- GitHub/source releases and npm publication remain independently authorized operations.
- Provider claims must not exceed observed/tested evidence.
- A GitHub/source release never implies registry publication.
- The aggregate required release-safety gate must remain aligned with the evidence promised by release policy.

See [Release policy](releasing.md), [Provider benchmark harness](provider-benchmarks.md), [v1.0 readiness review](v1-readiness.md), [Cost-bearing operations](cost-bearing-operations.md), and provider-specific documentation before production deployment.
