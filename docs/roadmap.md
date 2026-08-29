# Roadmap

[English](roadmap.md) | [日本語](roadmap.ja.md)

This roadmap protects the project's core category: **failure-safe transactional usage enforcement around MCP execution**.

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

The project should deepen correctness and production usability at that boundary rather than expand into a generic gateway, billing ledger, governance system, or workflow engine. See [Project positioning](positioning.md).

## Current baseline

**v0.10.0 is the current GitHub/source release baseline.** It adds bounded operational usability and dogfood diagnostics while preserving the existing accounting model.

All five publishable package manifests are aligned at `0.10.0`. **The packages are not published to npm.** First registry publication remains a separately authorized operation tracked by #6.

The active product target is **v0.11.0 / #152 -> #157 -> #105 + #106 -> #24 -> #6**, followed by **v1.0.0** as a feature-free stable promotion.

```text
v0.6 progressive growth [RELEASED]
 -> v0.7 atomic heterogeneous vectors [RELEASED]
 -> v0.8 scalar operation reconciliation [RELEASED]
 -> v0.9 repository-wide safety hardening [RELEASED]
 -> v0.10 operational usability [RELEASED]
 -> v0.11 accounting/completion/distribution/API freeze [ACTIVE]
 -> v1.0 stable promotion
```

## Safety boundary that must not regress

Across every remaining release:

- admission comparison and reservation stay one authoritative Store transition;
- all participating budgets reserve atomically or none do;
- pending vs cost-liable expiry semantics remain distinct and conservative;
- replay/idempotency identity remains scoped to one logical operation;
- ambiguous state-changing outcomes are not blindly retried;
- scalar/vector accounting never converts unlike dimensions into a synthetic total;
- MCP multi-round resume remains integrity-verified, binding-aware, and one-time;
- observability remains non-authoritative and cannot change enforcement outcomes;
- provider durability, time, HA, and lost-ACK limits remain explicit rather than upgraded into stronger claims without evidence.

## Completed pre-v1 capability decisions

| Release | Decision | Status |
| --- | --- | --- |
| **v0.6.0** | Optional progressive reservation growth through `UsageLease.grow()` / `ProgressiveUsageStore` | Released / adopted |
| **v0.7.0** | Optional atomic heterogeneous vector usage through `VectorUsageControl` / `VectorUsageStore` | Released / adopted |
| **v0.8.0** | Optional read-only scalar operation reconciliation through `OperationReconciliationStore` | Released / adopted |
| **v0.9.0** | Repository-wide safety hardening #116-#127 plus Firestore race blocker #143 | Released / complete |
| **v0.10.0** | Operational snapshot/runtime identity, canonical settlement diagnostics, scoped threshold/exhaustion helpers | **Released / adopted** |

### v0.9 safety evidence carried forward

v0.9 preserved the public accounting model while hardening capability intersections. It closed the repository-audit safety set #116-#127 and Firestore blocker #143 without weakening `vector-growth-vs-settle-race`.

Firestore outer retry remains limited to definitive transaction aborts (`ABORTED` / gRPC 10 and HTTP 409) with bounded jittered backoff. `UNKNOWN`, `UNAVAILABLE`, `INVALID_ARGUMENT`, and other ambiguous/provider failures are not added to that retry allow-list.

## v0.10.0 — operational usability [complete]

Issues **#76 -> #99 -> #82** are complete.

v0.10 adds three explicit public core subpaths:

- `mcp-usage-control/operational` — process-local bounded lifecycle counters, static runtime identity, and explicit scoped quota projection;
- `mcp-usage-control/settlement-outcomes` — canonical settlement vocabulary, bounded alias normalization, and distinguishable `invalid_settlement_outcome` diagnostics;
- `mcp-usage-control/thresholds` — pure threshold evaluation/crossing helpers over an explicitly scoped quota snapshot.

The release deliberately does **not** create a second accounting truth:

- operational counters are best-effort/process-local and never enforce quota;
- active-reservation counts are not inferred from replayable or aggregate lifecycle events;
- authoritative `remaining` is exposed only after the application selects the exact budget/window;
- threshold window/reset state and notification delivery remain application-owned;
- invalid-outcome diagnostics never weaken settlement validation or reveal the raw rejected value;
- observer/diagnostic sink failure cannot alter admission, liability, renewal, or settlement.

Release packaging verifies the three new subpaths in npm tarball contents and clean-consumer imports. English/Japanese operational guidance is in [Operational usability](operational-usability.md).

A post-release audit found one provider-observer integration gap: Firestore recovery events used a narrower provider-specific observer type while the common recovery event vocabulary omitted `firestore`. That gap is a telemetry/type-integration defect, not an accounting-state defect, and is being corrected before the v0.11 freeze.

## Active target: v0.11.0 — accounting contract / completion / distribution / compatibility freeze

v0.11 is the final pre-v1 completion line, not another feature-expansion cycle.

Execution priority:

1. **#152 cost-bearing operation reservation lifecycle** — prove that the existing reserve/liability/grow/settlement model cleanly covers provider-backed cost-bearing work, shared accounting scopes, idempotent retries, conservative ambiguous outcomes, proven-no-effect release, bounded maximum exposure, variable provider cost, and delayed final usage evidence; add API only if the existing model is insufficient.
2. **#157 Firestore progressive growth-concurrency reliability** — classify the observed Emulator `Transaction is invalid or closed` failure without weakening fail-closed retry policy or growth atomicity, and obtain repeated evidence before the final v1 freeze.
3. **#105 Node support floor** and **#106 persisted-state compatibility** — freeze runtime and storage compatibility boundaries.
4. **#24 Cloudflare real-operation boundary** — complete real credential rotation and the final honest platform-limit evidence statement.
5. **#6 first npm publication** — only with separate explicit authorization, after the public contract is frozen.
6. **public API/name freeze and final release evidence**, including settlement outcome typing and release-safety gate review.

It must resolve or explicitly scope:

- entitlement, pricing, subscription state, and provider policy stay application-owned;
- shared accounting scope, operation identity, liability, settlement, and no-effect/refund mapping for cost-bearing work are explicit;
- variable provider cost is bounded by maximum pre-reservation or pre-dispatch progressive growth; average expected cost alone is not presented as a hard spend cap;
- provider retries that may create additional cost exposure reserve/grow before each additional billable dispatch;
- count quotas and provider-cost budgets remain distinct dimensions where units differ;
- delayed final provider usage evidence has an honest bounded-support policy rather than silent under-accounting;
- Firestore recovery observability is type-compatible with the provider-neutral operational monitor;
- #157 is classified and resolved/scoped with repeated Emulator evidence and no blanket retry of ambiguous state-changing failures;
- Node support, persisted-state upgrade/migration/rollback, and newer-schema fail-closed guarantees are frozen;
- all five package names, exports/subpaths, error/status vocabulary, settlement outcome typing, and lifecycle semantics receive a final public-contract review;
- MCP Tasks / MRTR surfaces are adopted only where upstream stability and equivalent safety proof exist; otherwise they are explicitly deferred;
- production/package/source-release evidence is green and release-critical provider checks cannot be accidentally bypassed by merge policy;
- npm publication occurs only if separately authorized and then includes registry/provenance/clean-install verification.

No unresolved issue classified as a v1 blocker may remain when v0.11 closes.

## What “v1 complete” means

v1.0 is a **stable promotion of an already completed surface**. It should not be the release where unresolved product or accounting questions are decided.

Before v1.0:

- every material capability has an explicit adopt/defer/exclude decision;
- adopted capabilities have failure semantics, concurrency/provider evidence, packaging coverage, and bilingual documentation;
- public package names, exports, lifecycle semantics, Store support claims, Node support, and MCP integration boundaries are frozen;
- cost-bearing operation semantics are explicitly mapped to the frozen accounting lifecycle;
- first npm publication has been exercised under separate authorization;
- persisted-state compatibility and rollback boundaries are documented;
- final production evidence is green;
- pre-v1 reliability follow-ups such as #157 are closed or explicitly scoped with evidence;
- release-critical CI/provider evidence is represented by a required aggregate gate or an equally strong branch-protection policy.

**v1.0 itself should add no new feature or accounting model.**

## Issue classification toward v1

| Issue | Target | Direction |
| --- | --- | --- |
| #83 progressive reservation growth | v0.6 | Adopted / released |
| #84 heterogeneous multi-dimensional usage | v0.7 | Adopted / released |
| #81 operation reconciliation/status | v0.8 | Adopted / released |
| #116-#127 repository safety hardening | v0.9 | Completed / released |
| #143 Firestore vector growth-vs-settle race | v0.9 | Completed release blocker |
| #76 operational usage snapshot | v0.10 | Completed / released |
| #99 settlement outcome normalization / dogfood diagnostics | v0.10 | Completed / released |
| #82 threshold/exhaustion signals | v0.10 | Completed / released |
| #152 cost-bearing operation reservation lifecycle | v0.11 | **Active / accounting-contract freeze** |
| #157 Firestore progressive growth-concurrency reliability | v0.11 | **Pre-v1 reliability evidence** |
| #105 Node.js support floor | v0.11 | Runtime support freeze |
| #106 persisted-store compatibility | v0.11 | Storage compatibility freeze |
| #24 Cloudflare real operational evidence | v0.11 | Final production evidence |
| #6 first npm publication | v0.11 | **Open; separate explicit authorization required** |

## Release policy

- One release gate must not silently change runtime/accounting semantics merely to make release mechanics easier.
- GitHub/source releases and npm publication remain independently authorized operations.
- A GitHub/source release does not imply registry publication.
- Release documentation describes observed provider evidence, not stronger guarantees than tests and deployment profiles prove.
- Before v1, branch protection should require a release-safety aggregate that reflects applicable Node/package, Redis, Cloudflare, and Firestore evidence, or an equivalently strong policy.

See [Release policy](releasing.md), [v1.0 readiness review](v1-readiness.md), and provider-specific documentation before production deployment.
