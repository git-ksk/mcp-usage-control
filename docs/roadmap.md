# Roadmap

This roadmap protects the project's core category: **transactional usage/quota enforcement around MCP execution**.

The core lifecycle is intentionally different from ordinary request rate limiting or post-hoc usage metering:

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

The roadmap prioritizes correctness of that transaction model before broader integrations.

## v0.1 completion priorities

1. **Production multi-round hardening** — `input_required` suspend/resume accounting is implemented; add shared/durable flow-store adapters and post-claim reconciliation without weakening one-time consume or fail-closed semantics. Tracked in #41.
2. **Real Cloudflare operational evidence** — complete the remaining credential-rotation and genuine platform-limit/failure observations for the deployed Durable Objects adapter. Tracked in #24.
3. **Public package contract review** — freeze the core/MCP/Redis/Cloudflare public contracts before npm publication and keep publication explicitly gated. Tracked in #6.
4. **Failure semantics documentation** — keep crash recovery, lost/ambiguous ACK, cost liability, multi-round claim/recovery, and reconciliation expectations explicit in architecture and adapter docs.

## After v0.1

### Third-party store invariant kit

Provide a reusable compatibility test kit for stores that want to implement the usage-store contract. A store should not claim compatibility unless it can demonstrate at least:

- atomic all-or-nothing multi-budget reservation;
- idempotent replay behavior;
- pending-vs-cost-liable expiry recovery;
- renewable/resumable lease behavior where applicable;
- conflicting settlement rejection;
- fail-closed storage behavior;
- an authoritative store-time model where required;
- safe handling of ambiguous settlement outcomes.

### Stable enforcement event contract

Version the observer/event schema so telemetry and billing adapters can consume enforcement outcomes without becoming part of the transaction result.

Observer/exporter failures must remain unable to change admission or settlement state.

### External billing and metering adapters

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

### Policy examples

Add production-oriented examples for atomic combinations such as:

- per-user daily + monthly budgets;
- per-user + tenant budgets;
- tool-weighted units;
- free/paid entitlement policy inputs;
- reconciliation with a separate durable financial ledger where required.

## Non-goals

The core runtime should not become:

- a generic HTTP/API rate limiter;
- a payment processor or subscription checkout system;
- an OAuth/identity provider;
- a billing dashboard;
- a financial-grade ledger;
- a gateway/router product;
- an implementation of a vendor billing protocol;
- a system that blindly retries ambiguous state-changing settlement calls.

Integrations with those systems belong at explicit adapter/policy boundaries.
