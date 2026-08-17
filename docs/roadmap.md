# Roadmap

This roadmap protects the project's core category: **failure-safe transactional usage enforcement around MCP execution**.

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

The project should deepen correctness and production usability at that boundary rather than expand into a generic agent-budget, gateway, billing, governance, or workflow product. See [Project positioning](positioning.md).

## Current baseline

**v0.5.0 is released** as the pre-v1 stabilization baseline.

It carries the resolved Firestore ACK-loss and bounded clock-skew contracts, Node.js 20/22/24 full-matrix evidence, mutable same-key quota-limit semantics, portable Store conformance across Memory/Redis/Cloudflare/Firestore, and Cloudflare bearer-token rotation support.

The current runtime still uses bounded fixed reservations and one scalar quoted/actual unit count across every budget participating in a reservation. Those are v0.5 semantics, not an irreversible v1 freeze.

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
| **v0.6.0** | #83 progressive reservation growth | Include failure-safe reservation top-up in v1 | Atomic multi-budget growth, retry identity, lost-ACK safety, liable/expiry semantics, settlement bound, Store/concurrency proof; otherwise explicitly exclude/defer from v1 |
| **v0.7.0** | #84 heterogeneous multi-dimensional usage | Include atomic vector/per-dimension accounting in v1 if it composes cleanly with the v0.6 decision | One logical replay identity, atomic admission/settlement across dimensions, deterministic retry/conflict semantics, Store conformance; otherwise explicitly exclude/defer |
| **v0.8.0** | #81 operation reconciliation/status | Include a coherent read-only reconciliation capability and per-Store support matrix | No second reservation, authoritative/provable states only, explicit `unknown/indeterminate`, adapter-specific lost-ACK evidence; otherwise define and freeze the narrower supported boundary |
| **v0.9.0** | #76 operational snapshot + #82 threshold/exhaustion signals | Include bounded non-authoritative production observability/tooling or canonical helpers | No second accounting truth, scoped authoritative values only, privacy/cardinality safety, helper failure isolated from enforcement; documentation-only outcome is acceptable if a stateful API adds more risk than value |
| **v0.10.0** | Final completion / distribution / API freeze | Close all remaining v1-scope decisions and prove the public distribution | #24 Cloudflare real-operation boundary, #6 first npm publication, final public API/name review, Tasks/MRTR scope decision, full integration/package/registry dogfood, no unresolved v1 blocker |
| **v1.0.0** | Stable promotion | Declare the completed surface stable | No new feature; version/changelog/release promotion only after v0.10 completion criteria are satisfied |

`0.10.0` is intentionally valid SemVer; there is no requirement that `0.9.0` be followed immediately by `1.0.0`.

## Detailed decision targets

### v0.6.0 — progressive reservation growth (#83)

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

If those guarantees cannot be proven without weakening the current model, v0.6 records an explicit v1 exclusion/defer decision.

### v0.7.0 — heterogeneous multi-dimensional usage (#84)

This decision follows #83 because progressive growth and multiple dimensions need a coherent composition model.

The preferred v1 design supports one logical operation consuming different dimensions such as request count, model tokens, compute seconds, or provider work units while preserving one atomic admission/settlement domain for the required dimensions.

Independent reserve calls that can partially commit are not equivalent. If a provider-neutral vector model cannot be added safely and compatibly across supported Stores, v0.7 explicitly keeps scalar accounting as the v1 contract and closes the decision.

### v0.8.0 — operation reconciliation/status (#81)

A complete failure-safe product should define what operators can safely learn after an ambiguous state-changing acknowledgement.

The preferred outcome is a small read-only status vocabulary plus an explicit per-Store capability matrix. Unsupported or unprovable states remain `unknown/indeterminate` and fail closed. Business result replay stays application-owned.

A universal mandatory Store lookup is not required if adapter-specific capability is the safer design.

### v0.9.0 — operational usability (#76, #82)

The preferred v1 surface includes enough optional operational tooling that applications do not have to reinvent the distinction between:

- retained bookkeeping state;
- lifecycle telemetry;
- authoritative scoped quota state;
- threshold/exhaustion notifications.

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
| #83 progressive reservation growth | **v0.6.0** | Prefer inclusion if atomic top-up proof succeeds |
| #84 heterogeneous multi-dimensional usage | **v0.7.0** | Prefer inclusion if atomic vector model composes safely with #83 |
| #81 operation reconciliation/status | **v0.8.0** | Prefer inclusion as read-only capability vocabulary + Store support matrix |
| #76 operational usage snapshot | **v0.9.0** | Prefer bounded non-authoritative helper/pattern |
| #82 threshold/exhaustion signals | **v0.9.0** | Prefer optional scoped helper/pattern built on #76 semantics |
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
import { assertUsageStoreConformance } from 'mcp-usage-control/conformance';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';
```

Any adopted v0.6-v0.9 capability that changes Store behavior must extend the portable contract where applicable. Passing portable conformance is necessary but never substitutes for backend-specific durability, failover, time, and lost-ACK evidence.

## Non-goals

The core runtime should not become a generic agent runtime/budget authority, ordinary HTTP rate limiter, payment/subscription system, financial ledger, OAuth provider, billing dashboard/pricing catalog, gateway/router, vendor billing protocol implementation, generic workflow engine, or a system that blindly retries ambiguous state-changing operations.
