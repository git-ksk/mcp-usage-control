# Roadmap

This roadmap protects the project's core category: **failure-safe transactional usage enforcement around MCP execution**.

The core lifecycle is intentionally different from ordinary request rate limiting, post-hoc usage metering, or a general agent-budget platform:

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

The roadmap prioritizes correctness of that transaction model before broader integrations. See [Project positioning](positioning.md) for the strategic boundary.

## Strategic direction

The project should deepen its correctness guarantees rather than expand into a generic agent-budget, gateway, billing, or governance product.

The strongest differentiators to preserve and strengthen are:

- atomic admission before metered execution;
- the explicit `pending -> cost-liable` boundary;
- conservative crash/expiry behavior after execution may have started;
- safe handling of lost or ambiguous acknowledgements;
- idempotent logical-operation replay and conflicting-settlement rejection;
- MCP-native retry/multi-round continuity without duplicate reservation;
- provider-neutral store semantics that can be verified independently.

Broader platforms may offer dashboards, pricing catalogs, organization-wide governance, routing, payment flows, or multi-language agent integrations. Those capabilities are adjacent, but they are not a roadmap template for this runtime.

## Current priorities

1. **Production multi-round hardening** — `input_required` suspend/resume accounting is implemented and current-protocol proof shows no sticky MCP session is required. For v1, keep the existing shared/durable compare-and-consume flow state; a new stateless MRTR mode is deferred unless it can prove a stronger safety/operational result. Tracked in #41 and #63.
2. **MCP Tasks accounting** — the long-running accounting state machine is now defined and covered by core proof tests. First-class protocol adapter support remains deferred while the upstream Tasks extension / TypeScript surface is experimental; do not advertise it as stable support. Tracked in #63.
3. **Third-party Store invariant kit** — make the project's correctness contract executable so external stores can prove semantic compatibility rather than merely implement the same method names.
4. **Production-readiness audit** — finish public API/export/version, Store invariant, security, horizontal-scale, tarball/clean-consumer, Node support, CI/release, TODO/Issue, and breaking-change review before the v1 decision.
5. **Real Cloudflare operational evidence** — complete the remaining credential-rotation and genuine platform-limit/failure observations for the deployed Durable Objects adapter. Tracked in #24; classify whether any remaining evidence is a v1 blocker rather than assuming it is.
6. **Public package contract review / npm publication** — keep the first registry publication explicitly gated and perform final registry-facing contract/metadata verification immediately before publication. Tracked in #6. npm publication is not required for the current v1-readiness review and must remain manual/deferred.
7. **Failure semantics documentation** — keep crash recovery, lost/ambiguous ACK, cost liability, multi-round claim/recovery, task lifetime, and reconciliation expectations explicit in architecture and adapter docs.

## MCP-native correctness

Protocol-specific work belongs in the project when it changes accounting safety at the execution boundary.

### Multi-round request/response

Maintain one logical usage reservation across fresh MCP requests. Client-round-tripped request state must remain integrity-verified and rebound to trusted server-side principal/tool/argument identity before it can resume accounting state.

The **v1 direction** is the current shared/durable flow claim with atomic compare-and-consume. It already permits fresh requests to land on different server instances without sticky MCP session affinity.

A future stateless-friendly resume design should only be adopted where it can preserve and prove:

- one reservation per logical operation;
- one-time resume/claim behavior where required;
- fail-closed handling of ambiguous state transitions;
- trusted principal / tenant / tool / args binding;
- conservative post-execution liability semantics.

Stateless transport does not require stateless accounting. Shared state remains acceptable where atomic quota enforcement needs it; avoid unnecessary MCP session affinity or generic workflow state.

### MCP Tasks

The accounting state machine for long-running Tasks is defined in [MCP Tasks accounting](mcp-tasks-accounting.md) and exercised by `packages/core/src/task-accounting-proof.test.ts`.

The contract now explicitly covers:

- one admission/reservation per logical operation, independent of task ID;
- the liability boundary immediately before metered work rather than inferring liability from task status;
- lease renewal during active execution and intentional `input_required` waits;
- completion, failure, cancellation, abandonment, and worker crash;
- conservative treatment of ambiguous reserve/liability/renew/settlement acknowledgements;
- no optimistic refund on cooperative cancellation acknowledgement;
- reconciliation without blind business replay;
- strict separation of task/result/worker state from the usage ledger.

No new core runtime primitive is required. First-class MCP Tasks adapter support remains deferred while the upstream extension is experimental. That integration is not a v1 accounting blocker as long as the public API/docs do not claim stable protocol-level Tasks support.

## Third-party store invariant kit

Provide a reusable compatibility test kit for stores that want to implement the usage-store contract. A store should not claim compatibility unless it can demonstrate at least:

- atomic all-or-nothing multi-budget reservation;
- idempotent replay behavior;
- pending-vs-cost-liable expiry recovery;
- renewable/resumable lease behavior where applicable;
- conflicting settlement rejection;
- fail-closed storage behavior;
- an authoritative store-time model where required;
- safe handling of ambiguous reserve/settlement outcomes.

The kit should make the project's differentiator measurable: correctness under concurrency, retry, crash, expiry, and acknowledgement ambiguity.

## Stable enforcement event contract

Version the observer/event schema so telemetry and billing adapters can consume enforcement outcomes without becoming part of the transaction result.

Observer/exporter failures must remain unable to change admission or settlement state.

## External billing and metering adapters

Keep this boundary explicit:

```text
transactional enforcement core
        -> stable observer/event contract
        -> optional billing/telemetry adapter
```

External billing or MCP metering specifications may define balances, entitlements, prices, invoices, receipts, or usage events with different guarantees. Adapters may translate stable enforcement outcomes into those schemas, but external terminology or semantics must not weaken or replace:

- atomic admission;
- reservation;
- cost-liability state;
- idempotency;
- lease/expiry recovery;
- conservative handling of ambiguous settlement.

Do not rename core concepts merely to resemble an external billing protocol unless the semantics are actually equivalent.

## Policy examples

Add production-oriented examples for atomic combinations such as:

- per-user daily + monthly budgets;
- per-user + tenant budgets;
- tool-weighted units;
- free/paid entitlement policy inputs;
- reconciliation with a separate durable financial ledger where required.

## Non-goals

The core runtime should not become:

- a generic agent runtime or agent-budget authority;
- a generic HTTP/API rate limiter;
- a payment processor or subscription checkout system;
- an OAuth/identity provider;
- a billing dashboard or pricing catalog;
- a financial-grade ledger;
- a gateway/router product;
- an implementation of a vendor billing protocol;
- a workflow engine for replaying arbitrary business side effects;
- a system that blindly retries ambiguous state-changing settlement calls.

Integrations with those systems belong at explicit adapter/policy boundaries.
