# Roadmap

This roadmap protects the project's core category: **failure-safe transactional usage enforcement around MCP execution**.

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

The project should deepen correctness and production usability at that boundary rather than expand into a generic agent-budget, gateway, billing, governance, or workflow product. See [Project positioning](positioning.md).

## Current baseline

**v0.8.0 is released and closed out** as the current pre-v1 source baseline. #81 passed its design/implementation proof gate and read-only scalar operation reconciliation is adopted as an optional future-v1 Store capability. **v0.9.0 is now the active decision target.** Its first implementation phase is the repository-wide safety-hardening set #116-#127 found during the 2026-08-22 audit; after those correctness/security gaps are closed, v0.9 continues with #76 + #82 + #99 operational usability. Subscription-credit ergonomics #108 + #109 + #110 are completed adjacent v0.9 convenience work and remain non-blocking for v1.

The repository execution order is intentionally linear: **v0.8.0 closed -> adjacent #108+#109+#110 credit-policy ergonomics completed -> v0.9 safety hardening #116-#127 -> v0.9/#76+#82+#99 operational usability -> v0.10/#24+#6+#105+#106 and final freeze -> v1.0 stable promotion.** This is an implementation-order rule, not a requirement to publish v0.8.1 before v0.9.0. The safety fixes may land directly in v0.9.0; the important constraint is that new v0.9 observability/tooling must not be built on top of known fail-open, quota-integrity, reconciliation, or cross-capability regressions.

It carries the resolved Firestore ACK-loss and bounded clock-skew contracts, Node.js 20/22/24 full-matrix evidence, mutable same-key quota-limit semantics, portable Store conformance across Memory/Redis/Cloudflare/Firestore, and Cloudflare bearer-token rotation support.

The base runtime keeps the existing scalar reservation path unchanged. v0.6 adds optional progressive growth on scalar reservations, and v0.7 adds a separate optional atomic vector path for heterogeneous dimensions. Neither capability makes the base `UsageStore` contract mandatory for third-party Stores.

## What “v1 complete” means

v1.0 should be a **stable promotion of an already completed product surface**, not the release where unresolved feature questions are finally decided.

Before v1.0:

- every capability considered materially important to the v1 product must receive an explicit adopt/defer/exclude decision in a v0.x release;
- every adopted capability must have failure semantics, Store/concurrency evidence, packaging coverage, and English/Japanese documentation appropriate to its claim;
- deferred/excluded capabilities must be documented as deliberate non-v1 scope, not left as ambiguous blockers;
- public package names, subpath exports, core lifecycle semantics, Store support claims, Node support, and MCP integration boundaries must be frozen;
- first npm publication and registry installation/provenance should be exercised before v1 stable promotion;
- the final pre-v1 release must complete production-evidence and release-mechanics review.

**v1.0 itself should add no new feature or accounting model.** It should be the stable-version promotion of the completed pre-v1 surface after final green evidence.

## Pre-v1 completion ladder

Each release below is a **decision gate**. A target feature is not forced into v1 merely because it is scheduled. If its safety/compatibility proof fails, that release must explicitly defer or exclude it from v1 with rationale so the question does not remain open at v1.

| Release | Primary scope | Preferred outcome | Release gate |
| --- | --- | --- | --- |
| **v0.6.0** | #83 progressive reservation growth | **Adopted** as an optional v1 core/Store extension | `UsageLease.grow()` + optional `ProgressiveUsageStore`, growth cursor + stable increment identity, atomic multi-budget proof, lost-ACK replay fence, provider conformance |
| **v0.7.0** | #84 heterogeneous multi-dimensional usage | **Adopted** as an optional v1 core/Store extension | Separate `VectorUsageControl` / `VectorUsageStore`, one logical replay identity, atomic per-dimension admission/growth/settlement, deterministic retry/conflict semantics, provider conformance |
| **v0.8.0** | #81 operation reconciliation/status | **Adopted** as an optional scalar v1 Store capability | Common read-only status vocabulary, no second reservation, mismatch/unprovable state fail closed, Memory/Redis/Firestore support + Cloudflare reconciliation subpath, portable/provider evidence |
| **v0.9.0** | **Phase A:** audit hardening #116-#127. **Phase B:** #76 operational snapshot + #82 threshold/exhaustion signals + #99 dogfood integration diagnostics; adjacent #108/#109/#110 subscription-credit ergonomics | First restore/prove fail-closed and quota-integrity invariants across feature intersections, then include bounded non-authoritative production observability/tooling and a clear settlement-outcome contract | No known safety blocker carried into Phase B; malformed runtime decisions/auth must fail closed; maintenance must not invalidate active accounting; cross-capability regressions covered; then no second accounting truth, scoped authoritative values only, privacy/cardinality safety, helper failure isolated from enforcement |
| **v0.10.0** | Final completion / distribution / compatibility freeze | Close all remaining v1-scope decisions and prove the public distribution/runtime/storage compatibility boundary | #24 Cloudflare real-operation boundary, #6 first npm publication, #105 supported Node.js floor, #106 persisted-store upgrade/migration/rollback contract, final public API/name review, Tasks/MRTR scope decision, full integration/package/registry dogfood, no unresolved v1 blocker |
| **v1.0.0** | Stable promotion | Declare the completed surface stable | No new feature; version/changelog/release promotion only after v0.10/#24+#6+#105+#106 completion criteria are satisfied |

`0.10.0` is intentionally valid SemVer; there is no requirement that `0.9.0` be followed immediately by `1.0.0`.

## Detailed decision targets

### v0.6.0 — progressive reservation growth (#83)

**Decision: adopt for the future v1 stable surface.** The base `UsageStore` stays fixed-reservation compatible; growth is an optional extension for Stores that can prove the stronger transaction contract.

The current bounded-reservation model is correct but can be unnecessarily restrictive for streaming, iterative, or long-running metered work whose safe maximum is not practical to know at admission time.

The preferred v1 design adds progressive growth only if it preserves:

- atomic all-or-nothing growth across all participating budgets;
- concurrent admission correctness;
- stable idempotency identity for each increment;
- safe retry after lost acknowledgement without duplicate growth;
- explicit pending vs cost-liable semantics;
- conservative expiry/recovery after any committed increment;
- `actual <= total successfully reserved` settlement;
- one logical operation across multi-round and Tasks flows.

Those guarantees are implemented and proof-tested through Memory plus portable/provider-specific paths for Redis, Cloudflare Durable Objects, and Firestore. The v0.6 decision is therefore adoption, subject to the normal release CI/package gate.

### v0.7.0 — heterogeneous multi-dimensional usage (#84)

**Decision: adopt for the future v1 stable surface as an optional capability.** The scalar API remains unchanged; vector callers opt into `VectorUsageControl` / `VectorUsageStore`.

One logical operation may reserve different dimensions such as request count, model tokens, compute seconds, or provider work units without converting them into one synthetic scalar. Admission, growth, recovery, and settlement remain one reservation-wide atomic domain.

The proof covers scalar/vector operation collision, all-or-nothing multi-dimension admission, per-dimension settlement bounds, one growth cursor across the vector, exact lost-ACK replay, authoritative denial without partial growth, pending/liable expiry, and growth/settlement races across Memory, Redis, Cloudflare Durable Objects, and Firestore. Existing scalar Store implementations remain source-compatible.

### v0.8.0 — operation reconciliation/status (#81)

**Decision: adopt for the future v1 stable surface as an optional scalar Store capability.** The base `UsageStore` remains source-compatible. `OperationReconciliationStore` adds a read-only `reconcileOperation()` capability for Stores that can prove retained scalar operation state; Cloudflare keeps the equivalent authenticated reconciliation subpath rather than forcing the method onto the remote base API.

The common vocabulary is `absent`, `active/pending`, `active/liable`, `expired/pending`, `expired/liable`, and `settled`. Backend/transport failure, corrupt or unsupported state, and trusted-input mismatch do not become a successful status; callers classify them as indeterminate and fail closed. `absent` means only that no state is retained now and never becomes automatic replay authorization after the retention horizon.

Reconciliation is strictly read-only: it does not reserve or release capacity, mark liability, renew, settle, or rewrite replay state. Memory, Redis, and Firestore implement the optional interface; Cloudflare exposes the same core result vocabulary through `reconcileRemoteCloudflareOperation()`, while the v0.7 `reconcileRemoteCloudflareReserve()` name remains compatible. Portable conformance covers lifecycle status, repeated read-only expired observation, and expected-state mismatch; provider-specific ambiguity/time/durability evidence remains required.

The v0.8 claim is intentionally scalar-only. Vector initial-reserve ambiguity stays fail closed unless a later release adds a separately proven vector reconciliation mechanism. Business-result replay remains application-owned and outside usage accounting.

### v0.9.0 — safety hardening first, then operational usability (#116-#127, #76, #82, #99)

**Implementation order inside v0.9 is deliberate.** The 2026-08-22 whole-repository audit found correctness/security gaps mostly at intersections between capabilities that were individually well-tested. These are v0.9 blockers, not a separate mandatory v0.8.1 release line.

Phase A closes the audit set before new operational helpers are treated as the active implementation work:

1. **Immediate safety blockers:** #123 active-vector budget pruning can restore quota capacity; #126 gateway authorization accepts truthy non-boolean values; #122 malformed policy decision discriminants can fail open.
2. **Accounting/time/provider correctness:** #117 unsafe expiry/timer arithmetic, #116 Memory retained-budget capacity during growth, #120 Firestore expired-liable reconciliation semantics, #121 Cloudflare remote/maintenance protocol and timeout validation, #125 reconciliation pre-auth body buffering, #119 MCP flow-store unresolved-growth preservation, #124 Redis recovery aggregate overflow, and #118 runtime identity validation before mutation.
3. **Regression gate:** #127 adds cross-capability safety coverage so `retention x growth`, `flow-store x growth`, `recovery x reconciliation`, `maintenance x vector`, and similar feature intersections are tested explicitly rather than relying only on vertical capability conformance.

Phase A is complete only when the affected provider-specific tests/conformance pass and the fixes preserve the stable invariants below. npm publication is not part of this phase.

Phase B then continues the original v0.9 operational-usability decisions:

The preferred v1 surface includes enough optional operational tooling that applications do not have to reinvent the distinction between:

- retained bookkeeping state;
- lifecycle telemetry;
- authoritative scoped quota state;
- threshold/exhaustion notifications;
- canonical settlement-outcome vocabulary/normalization guidance and bounded diagnostics for integration drift found through real consumer dogfood (#99);
- privacy-safe lifecycle counters sufficient to distinguish service unavailability from invalid integration input without exposing principals, arguments, credentials, or request bodies.

The immediate Gateway mapping bug observed in #99 (`invalid_browser_request` -> canonical `invalid_arguments`) is a consumer integration fix and does **not** need to wait for v0.9. v0.9 owns the reusable MCPUsage-side contract, diagnostics, and operational visibility that prevent or quickly identify the same drift in other consumers.

This tooling remains best-effort/non-authoritative. It must not become a second ledger, infer budget-window resets, or make notification delivery part of enforcement correctness.

If a reusable stateful helper creates more complexity than value, a canonical documented pattern/examples may satisfy the v1 product requirement.

Completed adjacent production ergonomics work:

- **#108 subscription-style weighted-credit guide — completed:** documents the end-to-end `plan allowance -> tool units -> window key -> reserve/settle` pattern in English/Japanese, including same-window plan changes and billing/history boundaries.
- **#109 weighted-credit quote helper — completed:** added a small validated `UsagePolicy` composition helper for trusted `tool -> units` mappings, explicit unknown-tool handling, and caller-owned plan/budget resolution.
- **#110 accounting-window key helper — completed:** added deterministic day/month key construction (scope, window, time zone/clock input) so applications do not hand-roll key rotation, while keeping calendar/business-window ownership explicit and avoiding plan names in keys that would reset in-window usage.

These are **non-blocking v0.9 ergonomics**. They must not make MCPUsage own entitlement truth, Remote Config/Stripe/RevenueCat access, pricing catalogs, billing ledgers, or subscription lifecycle. If a helper would cross that boundary, keep the generic API and satisfy the need through #108 examples instead.

### v0.10.0 — completion release

v0.10 is the final pre-v1 completion line, not another feature-expansion cycle.

It must resolve:

- **Cloudflare #24:** execute real credential rotation; capture real platform-limit/overload evidence if naturally available, otherwise explicitly scope the v1 Cloudflare claim to observed evidence instead of manufacturing Free-plan exhaustion;
- **npm #6:** perform the first npm publication for the selected v0.10 tag only with separate explicit authorization, then verify provenance, registry metadata, contents, and clean registry installation;
- **Node support #105:** explicitly choose the v1 supported Node.js floor, align `engines`, CI/support claims, and clean-consumer evidence, and avoid treating EOL compatibility as an implicit support promise;
- **persisted-state compatibility #106:** define Redis / Firestore / Cloudflare upgrade, migration, newer-schema fail-closed, and rollback guarantees so SemVer/API stability does not hide a separate storage-state compatibility boundary;
- **public API/name freeze:** final review of all five package names, exports/subpaths, error/state terminology, lifecycle semantics, and compatibility statements;
- **MCP Tasks:** if the upstream TypeScript Tasks integration surface is stable enough, decide whether to include a first-class adapter; otherwise explicitly exclude it from the v1 stable surface while retaining the already proven accounting semantics;
- **stateless MRTR alternative:** unless concrete benefit and equivalent one-time/lost-ACK proof appear, explicitly keep the shared/durable compare-and-consume model as v1 and classify the alternative as non-v1 work;
- full Node 20/22/24, Redis, Cloudflare workerd, Firestore Emulator, package tarball, clean-consumer, and relevant deployed/manual evidence;
- zero unresolved issue that is still classified as a v1 release blocker.

## Issue classification toward v1

| Issue | Target decision | Current direction |
| --- | --- | --- |
| #83 progressive reservation growth | **v0.6.0** | **Adopted**: optional progressive Store capability + `UsageLease.grow()` |
| #84 heterogeneous multi-dimensional usage | **v0.7.0** | **Adopted**: optional atomic vector Store capability + `VectorUsageControl` |
| #81 operation reconciliation/status | **v0.8.0** | **Adopted**: optional scalar read-only capability vocabulary + Store support matrix |
| #123 Cloudflare active-vector pruning safety | **v0.9.0 Phase A blocker** | Prevent maintenance from deleting any budget referenced by active scalar or vector reservations; prove no quota capacity resurrection |
| #126 Cloudflare authorization callback validation | **v0.9.0 Phase A blocker** | Only literal `true` authorizes; malformed callback results fail closed |
| #122 runtime policy decision validation | **v0.9.0 Phase A blocker** | Unknown/malformed discriminants fail closed before Store mutation |
| #117 time / timer arithmetic safety | **v0.9.0 Phase A** | Reject/chunk unsafe expiry and platform timer values before authoritative mutation or renew scheduling |
| #116 Memory retained-budget growth capacity | **v0.9.0 Phase A** | Growth cannot bypass `maxRetainedBudgetKeys`, including zero-unit initial reserve |
| #120 Firestore expired-liable reconciliation | **v0.9.0 Phase A** | Preserve provider-neutral `expired / liable` semantics after recovery |
| #121 Cloudflare remote/maintenance protocol hardening | **v0.9.0 Phase A** | Method-specific reply validation and full-call timeout/status semantics |
| #125 reconciliation pre-auth body handling | **v0.9.0 Phase A** | Authenticate before buffering/parsing untrusted request bodies |
| #119 MCP unresolved growth round-trip | **v0.9.0 Phase A** | Preserve exact-retry fence through Memory/Redis flow-store suspend/resume |
| #124 Redis recovery aggregate overflow | **v0.9.0 Phase A** | No unsafe aggregate can turn a committed cleanup/admission into client-side ACK ambiguity |
| #118 runtime identity validation | **v0.9.0 Phase A** | Malformed JS runtime identity is rejected before hashing, provider calls, or accounting mutation |
| #127 cross-capability safety regression matrix | **v0.9.0 Phase A gate** | Add explicit interaction tests for independently introduced capabilities |
| #76 operational usage snapshot | **v0.9.0** | Prefer bounded non-authoritative helper/pattern |
| #82 threshold/exhaustion signals | **v0.9.0** | Prefer optional scoped helper/pattern built on #76 semantics |
| #99 settlement outcome normalization / dogfood diagnostics | **v0.9.0** | Clarify canonical integration vocabulary, distinguish invalid outcome from service outage, and add privacy-safe lifecycle visibility; consumer mapping bug may be fixed earlier |
| #108 subscription-style weighted credits guide | **Completed / v0.9 adjacent / non-blocking** | Canonical Free/Plus/monthly-credit adoption guide and responsibility boundary |
| #109 weighted-credit quote helper | **Completed / v0.9 adjacent / non-blocking** | Validated policy-composition helper removes repeated consumer code without owning pricing/subscriptions |
| #110 accounting-window key helpers | **Completed / v0.9 adjacent / non-blocking** | Deterministic day/month key helper uses explicit scope/time-zone inputs and never silently resets usage on plan changes |
| #24 Cloudflare deployed operational evidence | **v0.10.0** | Complete real rotation and finalize honest v1 evidence boundary |
| #6 first npm publication | **v0.10.0** | First registry publish before v1, but only with explicit authorization |
| #105 supported Node.js floor | **v0.10.0** | Decide supported v1 runtime floor and align engines/CI/docs before publication |
| #106 persisted-store migration/rollback contract | **v0.10.0** | Freeze provider upgrade/downgrade/schema compatibility semantics before v1 |
| #77/#78/#79/#85 | Resolved | Evidence carried forward into every later release |

The rule is: **no “maybe v1” item survives past v0.10.** It is either adopted with proof or explicitly classified outside the v1 stable product.

## Stable invariants that no pre-v1 feature may weaken

- admission comparison and reservation are one authoritative Store operation;
- every participating budget/dimension required by one logical admission commits atomically or none do;
- replay identity is stable and is not authentication;
- metered execution is preceded by explicit liability;
- pending expiry may release capacity, liable unknown usage remains conservative;
- ambiguous state-changing outcomes are not blindly retried;
- Store/platform failure does not become allow;
- malformed runtime policy/auth callback results do not become allow;
- maintenance/retention operations cannot delete or recreate accounting capacity still referenced by an active scalar or vector reservation;
- validation/time/protocol failures must be detected before authoritative mutation where the caller can otherwise observe a clean precondition failure;
- cross-capability interactions are part of the regression contract, not assumed from independent feature conformance;
- observability/alerts never become enforcement authority;
- business side-effect/result replay remains outside usage accounting;
- provider-specific durability/time/HA limitations remain explicit rather than being hidden behind an over-strong generic claim.

## MCP-native scope

The current multi-round direction remains shared/durable one-time compare-and-consume without sticky MCP sessions. Alternative stateless/client-carried claims must prove equivalent replay and acknowledgement-ambiguity safety before consideration.

[MCP Tasks accounting](mcp-tasks-accounting.md) already defines the safe accounting lifecycle. A first-class Tasks wire/runtime adapter is a v0.10 scope decision tied to upstream stability, not an unresolved accounting correctness gap.

## Third-party Store contract

Portable conformance remains a required behavioral baseline:

```ts
import {
  assertUsageStoreConformance,
  runProgressiveUsageStoreConformance,
} from 'mcp-usage-control/conformance';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';
```

Any adopted v0.6-v0.9 capability that changes Store behavior must extend the portable contract where applicable. Passing portable conformance is necessary but never substitutes for backend-specific durability, failover, time, and lost-ACK evidence.

## Non-goals

The core runtime should not become a generic agent runtime/budget authority, ordinary HTTP rate limiter, payment/subscription system, financial ledger, OAuth provider, billing dashboard/pricing catalog, gateway/router, vendor billing protocol implementation, generic workflow engine, or a system that blindly retries ambiguous state-changing operations.
