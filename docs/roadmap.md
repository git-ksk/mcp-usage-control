# Roadmap

This roadmap protects the project's core category: **failure-safe transactional usage enforcement around MCP execution**.

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

The project should deepen correctness at that boundary rather than expand into a generic agent-budget, gateway, billing, governance, or workflow product. See [Project positioning](positioning.md).

## Current release direction

The next source release is **v0.5.0**, not v1.0.0.

v0.5.0 is a pre-v1 stabilization release that packages the correctness and compatibility work completed after v0.4.0:

- Firestore ambiguous-commit / lost-ACK semantics and fault-injection evidence (#77);
- bounded Firestore cross-instance clock-skew support and deterministic evidence (#78);
- Node.js 24 on the same full CI/package/clean-consumer path as Node 20/22 (#79);
- same-key mutable quota-limit semantics plus portable Store conformance across Memory, Redis, Cloudflare, and Firestore (#85);
- Cloudflare bearer-token rotation support and local workerd rotation coverage;
- the current accounting-model boundary documentation for #83/#84.

The v1 readiness work remains useful evidence, but **v1 is no longer treated as the immediate next release or as already API-frozen**. After v0.5.0, the project will use implementation experience and integration needs to decide which open capabilities belong in v1.

## Current v0.5 behavior vs. v1 candidates

v0.5.0 keeps the current proven accounting model:

- a bounded fixed reservation is established before metered work;
- `actualUnits <= reservedUnits`;
- one scalar quoted/actual unit count is applied across every budget participating in one reservation;
- all participating budgets admit atomically or none do;
- a second logical operation is not an accounting-equivalent top-up workaround;
- independent per-dimension reserve calls are not an equivalent replacement when all-or-nothing admission is required.

These are **v0.5 behavior and current v1 candidates**, not an irreversible v1 freeze.

In particular:

- #83 progressive reservation growth remains open and may be included in v1 if a failure-safe atomic top-up protocol is proven before v1;
- #84 heterogeneous multi-dimensional usage remains open and may be included in v1 if a provider-neutral atomic vector model is proven before v1;
- if either design would destabilize the existing transaction guarantees or expand the release surface without sufficient evidence, it can still remain post-v1.

The project should choose the v1 boundary from demonstrated need and failure evidence, not from an artificial requirement that every previously labeled post-v1 item stay out of v1.

## Current priorities

1. **Release v0.5.0** — version all five packages together, publish the GitHub/source release after the full matrix is green, and keep npm publication separate/deferred.
2. **v0.5 stabilization / dogfood** — exercise the newly documented Firestore failure envelope, mutable-limit contract, Node 24 path, portable Store conformance, and Cloudflare credential rotation in normal use.
3. **Re-evaluate v1 scope** — decide whether #83 and/or #84, and any other low-risk high-value open capability, should enter v1 before the actual API freeze.
4. **Cloudflare operational evidence (#24)** — capture genuine platform-limit/overload/Free-plan exhaustion evidence when naturally/safely observable; do not burn shared quota solely to close the issue.
5. **First npm publication (#6)** — remain manual/deferred until separately authorized.
6. **Failure-semantics maintenance** — keep crash recovery, ACK ambiguity, liability, cancellation, multi-round claim/recovery, Tasks lifetime, reconciliation, mutable-policy boundaries, and Store-specific durability assumptions explicit as upstream protocols/providers evolve.

## Issue classification toward v1

| Issue | Current classification | v1 treatment |
| --- | --- | --- |
| #76 operational usage snapshot | Future optional operational capability | May be considered for v1 if it remains non-authoritative and low risk |
| #77 Firestore ambiguous-commit reconciliation | **Resolved correctness/evidence gate** | Evidence carried into v0.5 and future v1 |
| #78 Firestore cross-instance clock skew | **Resolved safety/evidence gate** | Evidence carried into v0.5 and future v1 |
| #79 Node 24 CI evidence | **Resolved support-policy gate** | Node 20/22/24 remain tested lines |
| #81 operation reconciliation/status capability | Future capability | Re-evaluate for v1 only if authoritative semantics are clear |
| #82 quota threshold/exhaustion signals | Future optional operational capability | Re-evaluate for v1 only as non-authoritative tooling |
| #83 progressive reservation growth | **Open v1-scope candidate** | Current v0.5 model has no top-up; v1 inclusion remains undecided pending proof |
| #84 heterogeneous multi-dimensional usage | **Open v1-scope candidate** | Current v0.5 model is scalar; v1 inclusion remains undecided pending atomic vector design |
| #85 mutable quota-limit semantics | **Resolved policy/Store-contract gate** | Portable conformance is part of the v0.5 evidence base |

This replaces the earlier planning assumption that #83/#84 were definitively post-v1. The earlier analysis remains useful design input; only the release-boundary finality changed.

## MCP-native correctness

Protocol-specific work belongs in core only when it changes accounting safety at the execution boundary.

### Multi-round request/response

The current direction is the existing shared/durable flow claim with atomic compare-and-consume. It preserves:

- one reservation per logical operation;
- integrity-verified client-round-tripped request state;
- trusted principal / tenant / tool / args binding;
- one-time resume claim;
- mismatch preservation of legitimate state;
- fail-closed ambiguous consume acknowledgement;
- no sticky MCP session requirement;
- conservative post-execution liability behavior.

A new stateless/client-carried claim design remains deferred unless it proves equivalent one-time/ambiguity safety and offers a concrete operational advantage.

### MCP Tasks

[MCP Tasks accounting](mcp-tasks-accounting.md) defines and proof-tests the safe accounting lifecycle, but the first-class Tasks protocol adapter remains deferred/experimental while the upstream TypeScript integration surface is experimental. This remains a v1 scope decision rather than a correctness gap in the existing core primitives.

## Third-party Store contract

The portable invariant kit is implemented. See [Store implementation contract](store-contract.md).

```ts
import { assertUsageStoreConformance } from 'mcp-usage-control/conformance';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';
```

A compatible Store must preserve atomic admission, replay/idempotency, pending-vs-liable expiry, renewal/resume, conflicting-settlement rejection, mutable-limit semantics, and fail-closed invalid/ambiguous state. Passing the portable runner proves behavioral compatibility, not backend durability, failover, authoritative time, or lost-ACK safety by itself.

## External billing and metering

Keep this boundary explicit:

```text
transactional enforcement core
        -> best-effort observer / stable package API
        -> optional billing/telemetry adapter
```

A financial-grade ledger, payment/subscription system, pricing catalog, gateway/router, OAuth provider, or arbitrary business-side-effect replay engine remains outside the core transaction model.

## Future candidates

Before v1, candidates may be pulled into the v1 scope only when concrete value and failure evidence justify the additional stable surface. After v1, the same rule applies under normal compatibility constraints.

Candidates include:

- #76 operational snapshots without a second accounting source of truth;
- #81 authoritative operation reconciliation/status where a Store can prove it;
- #82 threshold/exhaustion helpers as non-authoritative operational tooling;
- #83 progressive reservation growth with atomic top-up identity/replay/lost-ACK/expiry proof;
- #84 heterogeneous multi-dimensional usage with atomic provider-neutral vector semantics;
- a standalone versioned telemetry/event wire schema;
- optional billing/metering adapters;
- additional production policy examples;
- a first-class MCP Tasks adapter after upstream stabilization;
- alternative MRTR claims with equivalent one-time/ambiguity proof;
- additional provider Stores satisfying the same conformance/failure contract.

## Non-goals

The core runtime should not become a generic agent runtime/budget authority, ordinary HTTP rate limiter, payment/subscription system, financial ledger, OAuth provider, billing dashboard/pricing catalog, gateway/router, vendor billing protocol implementation, generic workflow engine, or a system that blindly retries ambiguous state-changing operations.
