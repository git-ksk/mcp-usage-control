# Roadmap

This roadmap protects the project's core category: **failure-safe transactional usage enforcement around MCP execution**.

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

The project should deepen correctness at that boundary rather than expand into a generic agent-budget, gateway, billing, governance, or workflow product. See [Project positioning](positioning.md).

## v1 readiness status

The post-v0.2 correctness program is complete enough to continue v1.0 release-candidate preparation. The detailed audit and blocker classification are in [v1.0 readiness review](v1-readiness.md).

Completed before the v1 decision:

- current MCP `2026-07-28` / TypeScript SDK v2 fresh-request multi-round proof;
- principal/tenant/tool/args-bound one-time resume with fail-closed ambiguous consume handling;
- explicit decision to keep shared/durable compare-and-consume as the v1 MRTR model, without sticky MCP sessions;
- long-running MCP Tasks accounting semantics and core proof tests;
- explicit separation of usage accounting from business task/result replay;
- normative third-party `UsageStore` / `McpUsageFlowStore` safety contracts;
- reusable portable conformance runners and package/clean-consumer coverage;
- public API/export/version, built-in Store, security, horizontal-scale, Node support, CI, release, and npm-publication workflow audit;
- README/API documentation synchronization and explicit stable/experimental/deferred boundaries.

The additional pre-v1 evidence/contract gates opened after the original readiness audit are now resolved: Firestore ambiguous-commit semantics (#77), bounded cross-instance clock-skew safety (#78), Node 24 full-matrix evidence (#79), and same-key mutable quota-limit semantics (#85). These changes did not require a redesign of the core transaction model.

The remaining pre-v1 work is an explicit **API-freeze boundary decision**, not an unimplemented correctness repair: #83 and #84 must be accepted as post-v1 capabilities under the current fixed-reservation / same-units multi-budget v1 contract, or changed before the stable tag.

## Current priorities

1. **Final API-freeze decisions (#83, #84)** — progressive reservation growth and heterogeneous multi-dimensional usage do not need to be implemented before v1, but the project must explicitly accept the current fixed-reservation / same-units multi-budget model as the v1 contract or change it before the stable tag.
2. **Release-candidate / API-freeze mechanics** — after that boundary decision and explicit release authorization, choose the exact release commit, version all five packages together, move only intended `Unreleased` changelog entries into the v1 section, run the full package/integration matrix, and review long-lived public names/semantics one last time. Do not tag/release as part of ordinary readiness work.
3. **Cloudflare operational evidence (#24)** — execute the documented real credential rotation and capture a genuine platform-limit/overload/Free-plan exhaustion event if/when safely observable. These are post-v1 operational evidence, not a provider-neutral core blocker. Do not intentionally burn shared Free-plan quota solely to close the issue.
4. **First npm publication (#6)** — remain explicitly manual/deferred. Registry publication is separate from source readiness and requires its own authorization.
5. **Failure semantics maintenance** — keep crash recovery, acknowledgement ambiguity, liability, cancellation, multi-round claim/recovery, Tasks lifetime, reconciliation, mutable-policy boundaries, and Store-specific durability assumptions explicit as upstream protocols/providers evolve.
6. **Operational observability (#76, #82)** — keep current observer/event behavior stable for v1, while treating richer operational snapshots and threshold/exhaustion signals as optional tooling outside the authoritative accounting state machine.

## Issue classification for the v1 boundary

The issues opened after the original readiness review are classified as follows.

| Issue | v1 classification | Current status for v1 |
| --- | --- | --- |
| #76 operational usage snapshot | Post-v1 optional operational tooling | Not a v1 blocker; current observability semantics remain the v1 boundary |
| #77 Firestore ambiguous-commit reconciliation | Pre-v1 Firestore evidence/contract gate | **Resolved** — explicit fail-closed reserve ambiguity plus retry/replay evidence for liability, renewal, and settlement |
| #78 Firestore cross-instance clock skew | Pre-v1 Firestore safety gate | **Resolved** — bounded/synchronized-clock deployment contract plus deterministic multi-instance evidence |
| #79 Node 24 CI evidence | Pre-v1 release/support-policy gate | **Resolved** — Node 20/22/24 run the same full build/test/package/clean-consumer matrix |
| #81 operation reconciliation/status capability | Post-v1 capability | Not a v1 blocker; unsupported/indeterminate states remain fail closed |
| #82 quota threshold/exhaustion signals | Post-v1 optional operational tooling | Not a v1 blocker |
| #83 progressive reservation growth | Post-v1 feature candidate; pre-v1 boundary decision | Implementation deferred; explicitly accept/defer current fixed-reservation model before API freeze |
| #84 heterogeneous multi-dimensional usage | Post-v1 design candidate; pre-v1 boundary decision | Implementation deferred; explicitly accept/defer current same-units multi-budget model before API freeze |
| #85 mutable quota-limit semantics | Pre-v1 policy/Store-contract gate | **Resolved** — same-key limit-change contract plus portable Memory/Redis/Cloudflare/Firestore conformance evidence |

This classification intentionally distinguishes **correctness/safety evidence needed to support an existing v1 claim** from **new capabilities that can safely remain outside v1**.

## MCP-native correctness

Protocol-specific work belongs in core only when it changes accounting safety at the execution boundary.

### Multi-round request/response

The **v1 direction** is the existing shared/durable flow claim with atomic compare-and-consume.

It preserves:

- one reservation per logical operation;
- integrity-verified client-round-tripped request state;
- trusted principal / tenant / tool / args binding;
- one-time resume claim;
- mismatch preservation of legitimate state;
- fail-closed ambiguous consume acknowledgement;
- no sticky MCP session requirement;
- conservative post-execution liability behavior.

A new stateless/client-carried claim design is deferred unless it proves the same invariants under concurrency and acknowledgement ambiguity and offers a concrete operational advantage.

Stateless transport does not imply stateless accounting.

### MCP Tasks

[MCP Tasks accounting](mcp-tasks-accounting.md) defines and proof-tests:

- one admission/reservation per logical operation independent of task ID;
- liability immediately before metered work, not inferred from `working`;
- renewal during authoritative execution and intentional input waits;
- completion, failure, cancellation, abandonment, and worker crash;
- conservative reserve/liability/renew/settlement ambiguity handling;
- no refund merely because cooperative cancellation was acknowledged;
- reconciliation without blind business replay;
- strict separation of task/result/worker ownership from `UsageStore`.

No new core primitive is required. First-class Tasks protocol integration remains **deferred/experimental** while the upstream TypeScript extension surface is experimental. Do not advertise stable Tasks adapter support until that boundary changes.

## Third-party Store contract

The planned invariant kit is now implemented. See [Store implementation contract](store-contract.md).

Portable runners are available at:

```ts
import { assertUsageStoreConformance } from 'mcp-usage-control/conformance';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';
```

A Store should not claim behavioral compatibility unless it can prove, as applicable:

- atomic all-or-nothing multi-budget admission;
- concurrent admission correctness;
- mutable effective-limit behavior without resetting same-key authoritative usage;
- logical-operation replay semantics;
- idempotent liability and settlement replay;
- pending-vs-liable expiry recovery;
- renewable/resumable state;
- conflicting settlement rejection;
- binding-aware one-time MCP flow consumption;
- fail-closed invalid/corrupt state behavior.

Passing the portable runner is necessary but not sufficient for a production-safe claim. Backend-specific durability, failover, authoritative time, and lost-ACK evidence remain required.

## External billing and metering

Keep this boundary explicit:

```text
transactional enforcement core
        -> best-effort observer / stable package API
        -> optional billing/telemetry adapter
```

External billing schemas may define balances, prices, invoices, receipts, or events with different guarantees. They must not weaken or replace:

- atomic admission;
- reservation;
- cost-liability state;
- idempotency;
- lease/expiry recovery;
- conservative handling of ambiguous settlement.

A financial-grade ledger remains a separate system boundary where required.

## Post-v1 candidates

Only add these when there is a concrete user/integration need and the change preserves the stable transaction model:

- operational snapshot/helper work from #76 without creating a second source of accounting truth;
- operation reconciliation/status capability from #81 where a Store can prove authoritative state;
- quota threshold/exhaustion helpers from #82 as non-authoritative operational tooling;
- progressive reservation growth from #83 if a safe atomic top-up model is proven;
- heterogeneous multi-dimensional usage from #84 if all dimensions can remain atomically admitted;
- a standalone versioned telemetry/event wire schema;
- optional external billing/metering adapters;
- additional production policy examples;
- a first-class MCP Tasks adapter after upstream stabilization;
- alternative MRTR claim representations only with equivalent one-time/ambiguity proof;
- additional provider Stores that can satisfy the same conformance/failure contract.

## Non-goals

The core runtime should not become:

- a generic agent runtime or budget authority;
- a generic HTTP/API rate limiter;
- a payment processor or subscription checkout system;
- an OAuth/identity provider;
- a billing dashboard or pricing catalog;
- a financial-grade ledger;
- a gateway/router product;
- an implementation of a vendor billing protocol;
- a workflow engine for replaying arbitrary business side effects;
- a system that blindly retries ambiguous state-changing operations.

Integrations with those systems belong at explicit adapter/policy boundaries.
