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

1. **Production multi-round hardening** — `input_required` suspend/resume accounting is implemented; continue shared/durable flow-store and post-claim reconciliation work without weakening one-time consume or fail-closed semantics. Tracked in #41.
2. **Current MCP protocol conformance** — explicitly validate the adapter against the current MCP protocol/SDK behavior, including fresh-request multi-round retry semantics, stateless server deployment assumptions, and long-running Tasks accounting. Keep any stateless-friendly MRTR option subject to the same trusted binding and accounting invariants. Tracked in #63.
3. **Third-party store invariant kit** — make the project's correctness contract executable so external stores can prove semantic compatibility rather than merely implement the same method names.
4. **Real Cloudflare operational evidence** — complete the remaining credential-rotation and genuine platform-limit/failure observations for the deployed Durable Objects adapter. Tracked in #24.
5. **Public package contract review / npm publication** — keep the first registry publication explicitly gated and perform final registry-facing contract/metadata verification immediately before publication. Tracked in #6.
6. **Failure semantics documentation** — keep crash recovery, lost/ambiguous ACK, cost liability, multi-round claim/recovery, task lifetime, and reconciliation expectations explicit in architecture and adapter docs.

## MCP-native correctness

Protocol-specific work belongs in the project when it changes accounting safety at the execution boundary.

### Multi-round request/response

Maintain one logical usage reservation across fresh MCP requests. Client-round-tripped request state must remain integrity-verified and rebound to trusted server-side principal/tool/argument identity before it can resume accounting state.

Evaluate stateless-friendly resume designs only where they preserve:

- one reservation per logical operation;
- one-time resume/claim behavior where required;
- fail-closed handling of ambiguous state transitions;
- trusted principal / tenant / tool / args binding;
- conservative post-execution liability semantics.

Stateless transport does not require stateless accounting. Shared state remains acceptable where atomic quota enforcement needs it; avoid unnecessary MCP session affinity or generic workflow state.

### MCP Tasks

Define accounting semantics for long-running Tasks before claiming first-class support. At minimum, the design must answer:

- when a reservation becomes cost-liable;
- how the lease is renewed while a task remains active;
- how completion, failure, cancellation, and abandonment settle usage;
- how worker/process loss is handled without optimistic refund;
- how a task result or business-side reconciliation stays separate from the usage ledger.

Do not turn the usage store into a general task/workflow engine.

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
