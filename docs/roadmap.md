# Roadmap

This roadmap protects the project's core category: **failure-safe transactional usage enforcement around MCP execution**.

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

The project should deepen correctness and production usability at that boundary rather than expand into a generic gateway, billing ledger, governance system, or workflow engine. See [Project positioning](positioning.md).

## Current baseline

**v0.9.0 is the latest GitHub/source release baseline.** It was released on 2026-08-22 from tested commit `e2a8f8e5dcf725a2c085faa3170a8e38e91504d2` after the repository-wide safety hardening set #116-#127 and Firestore release blocker #143 were closed.

All five publishable package manifests are aligned at `0.9.0`. **The packages are not published to npm.** First registry publication remains a separately authorized operation tracked by #6.

The active product target is **v0.10.0 / #76 + #82 + #99 operational usability and dogfood diagnostics**, followed by **v0.11.0 / #24 + #6 + #105 + #106 final production/distribution evidence and API freeze**, then **v1.0.0** as a feature-free stable promotion.

Repository execution order:

```text
v0.6 progressive growth
 -> v0.7 atomic heterogeneous vectors
 -> v0.8 scalar operation reconciliation
 -> v0.9 repository-wide safety hardening [RELEASED]
 -> v0.10 operational usability [ACTIVE]
 -> v0.11 completion/distribution/API freeze
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
| **v0.9.0** | Repository-wide safety hardening #116-#127 plus Firestore race blocker #143 | **Released / complete** |

### v0.9.0 release evidence

v0.9 preserved the public accounting model while hardening capability intersections. The release includes the repository-audit fixes for retained-budget growth integrity, safe expiry/timer arithmetic, validation-before-mutation, unresolved MCP growth preservation, Firestore expired-liable reconciliation, Cloudflare remote/maintenance validation, malformed-policy fail-close, vector-maintenance quota integrity, Redis recovery overflow, pre-auth reconciliation handling, strict boolean authorization, and the cross-capability regression matrix.

Issue #143 was resolved without weakening `vector-growth-vs-settle-race`. Firestore outer retry is limited to definitive transaction aborts (`ABORTED` / gRPC 10 and HTTP 409) with bounded jittered backoff; `UNKNOWN`, `UNAVAILABLE`, `INVALID_ARGUMENT`, and other ambiguous/provider failures are not added to that outer retry allow-list.

Release validation covered Node 20/22/24 package/clean-consumer CI, Redis, Cloudflare local workerd, and Firestore Emulator. The `v0.9.0` GitHub/source release completed successfully. npm publication was not completed and remains deferred under #6.

## Active target: v0.10.0 — operational usability

Primary issues: **#76, #82, #99**.

The goal is bounded operational visibility without creating a second accounting truth. The preferred surface should help applications distinguish:

- retained bookkeeping state;
- lifecycle telemetry;
- authoritative scoped quota state;
- threshold/exhaustion signals;
- canonical settlement-outcome vocabulary and integration drift;
- privacy-safe diagnostics that distinguish service failure from invalid integration input.

Requirements:

- helpers/signals are optional and non-authoritative;
- no implicit budget-window inference;
- no PII/high-cardinality identifiers promoted into default metrics;
- helper/observer failure never changes admission or settlement;
- vector dimensions remain semantically distinct;
- consumer mapping bugs may be fixed immediately and do not need to wait for v0.10.

Completed adjacent ergonomics #108, #109, and #110 remain non-blocking and do not make MCPUsage own entitlement truth, pricing catalogs, billing ledgers, or subscription lifecycle.

## v0.11.0 — completion / distribution / compatibility freeze

v0.11 is the final pre-v1 completion line, not another feature-expansion cycle.

It must resolve or explicitly scope:

- **#24 Cloudflare real-operation boundary:** credential rotation plus naturally available platform-limit/overload evidence; do not manufacture Free-plan exhaustion merely for proof;
- **#6 first npm publication:** only with separate explicit authorization; verify names/ownership, Trusted Publishing or bootstrap credentials, registry metadata, provenance, package contents, and clean registry installation;
- **#105 Node support floor:** choose the v1 Node.js support floor and align `engines`, CI, docs, and consumer evidence;
- **#106 persisted-state compatibility:** document Redis / Firestore / Cloudflare upgrade, migration, rollback, and newer-schema fail-closed guarantees;
- **public API/name freeze:** final review of all five package names, exports/subpaths, error/state terminology, lifecycle semantics, and compatibility claims;
- **MCP Tasks / MRTR scope:** adopt only surfaces with stable upstream and equivalent safety proof; otherwise explicitly defer them from v1;
- **full release evidence:** integration, package, source-release, and—once explicitly authorized—registry dogfood.

No unresolved issue classified as a v1 blocker may remain when v0.11 closes.

## What “v1 complete” means

v1.0 is a **stable promotion of an already completed surface**. It should not be the release where unresolved product or accounting questions are decided.

Before v1.0:

- every material capability has an explicit adopt/defer/exclude decision;
- adopted capabilities have failure semantics, concurrency/provider evidence, packaging coverage, and bilingual documentation;
- public package names, exports, lifecycle semantics, Store support claims, Node support, and MCP integration boundaries are frozen;
- first npm publication has been exercised under separate authorization;
- persisted-state compatibility and rollback boundaries are documented;
- final production evidence is green.

**v1.0 itself should add no new feature or accounting model.**

## Issue classification toward v1

| Issue | Target | Direction |
| --- | --- | --- |
| #83 progressive reservation growth | v0.6 | Adopted / released |
| #84 heterogeneous multi-dimensional usage | v0.7 | Adopted / released |
| #81 operation reconciliation/status | v0.8 | Adopted / released |
| #116-#127 repository safety hardening | v0.9 | Completed / released |
| #143 Firestore vector growth-vs-settle race | v0.9 | Completed release blocker |
| #76 operational usage snapshot | v0.10 | Active |
| #82 threshold/exhaustion signals | v0.10 | Active |
| #99 settlement outcome normalization / dogfood diagnostics | v0.10 | Active |
| #24 Cloudflare real operational evidence | v0.11 | Final completion evidence |
| #6 first npm publication | v0.11 | **Open; separate explicit authorization required** |
| #105 Node.js support floor | v0.11 | Freeze before v1 |
| #106 persisted-store compatibility | v0.11 | Freeze before v1 |

## Release policy

- One release gate must not silently change runtime/accounting semantics merely to make release mechanics easier.
- GitHub/source release and npm publication remain independently authorized operations.
- A GitHub/source release does not imply registry publication.
- A failed or cancelled npm workflow does not make a source release incomplete when registry publication is explicitly deferred.
- Release documentation must describe observed provider evidence, not stronger guarantees than the tests and deployment profile prove.

See [Release policy](releasing.md), [v1.0 readiness review](v1-readiness.md), and the provider-specific documentation before production deployment.
