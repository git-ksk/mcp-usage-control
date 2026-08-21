# Roadmap

This roadmap protects the project's core category: **failure-safe transactional usage enforcement around MCP execution**.

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

The project should deepen correctness and production usability at that boundary rather than expand into a generic agent-budget, gateway, billing, governance, or workflow product. See [Project positioning](positioning.md).

## Current baseline

**v0.8.0 is released and closed out** as the current pre-v1 source baseline. #81 passed its design/implementation proof gate and read-only scalar operation reconciliation is adopted as an optional future-v1 Store capability. **v0.9.0 / #76 + #82 + #99 is now the active decision target.**

The repository execution order is intentionally linear: **v0.8.0 closed -> v0.9/#76+#82+#99 (active) -> v0.10/#24+#6 and final freeze -> v1.0 stable promotion.** Dogfood bugs that affect a consumer today may be fixed earlier without changing that product-level ladder.

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
| **v0.9.0** | #76 operational snapshot + #82 threshold/exhaustion signals + #99 dogfood integration diagnostics | Include bounded non-authoritative production observability/tooling, canonical helpers, and a clear settlement-outcome integration contract | No second accounting truth, scoped authoritative values only, privacy/cardinality safety, helper failure isolated from enforcement, canonical outcome vocabulary/normalization, bounded diagnostics for invalid settlement vocabulary; documentation-only outcome is acceptable if a stateful API adds more risk than value |
| **v0.10.0** | Final completion / distribution / API freeze | Close all remaining v1-scope decisions and prove the public distribution | #24 Cloudflare real-operation boundary, #6 first npm publication, final public API/name review, Tasks/MRTR scope decision, full integration/package/registry dogfood, no unresolved v1 blocker |
| **v1.0.0** | Stable promotion | Declare the completed surface stable | No new feature; version/changelog/release promotion only after v0.10 completion criteria are satisfied |

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

### v0.9.0 — operational usability (#76, #82, #99)

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

### v0.10.0 — completion release

v0.10 is the final pre-v1 completion line, not another feature-expansion cycle.

It must resolve:

- **Cloudflare #24:** execute real credential rotation; capture real platform-limit/overload evidence if naturally available, otherwise explicitly scope the v1 Cloudflare claim to observed evidence instead of manufacturing Free-plan exhaustion;
- **npm #6:** perform the first npm publication for the selected v0.10 tag only with separate explicit authorization, then verify provenance, registry metadata, contents, and clean registry installation;
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
| #76 operational usage snapshot | **v0.9.0** | Prefer bounded non-authoritative helper/pattern |
| #82 threshold/exhaustion signals | **v0.9.0** | Prefer optional scoped helper/pattern built on #76 semantics |
| #99 settlement outcome normalization / dogfood diagnostics | **v0.9.0** | Clarify canonical integration vocabulary, distinguish invalid outcome from service outage, and add privacy-safe lifecycle visibility; consumer mapping bug may be fixed earlier |
| #24 Cloudflare deployed operational evidence | **v0.10.0** | Complete real rotation and finalize honest v1 evidence boundary |
| #6 first npm publication | **v0.10.0** | First registry publish before v1, but only with explicit authorization |
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
