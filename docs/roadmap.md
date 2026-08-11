# Roadmap

[English](roadmap.md) | [日本語](roadmap.ja.md)

This roadmap is intentionally organized around **transactional usage-enforcement invariants**, not feature count. New integrations may extend storage, MCP protocol support, observability, or billing export, but they must not weaken atomic admission, liability, idempotency, recovery, or settlement.

## Product boundary

The core category is transactional usage / quota enforcement around metered execution.

In scope:

- atomic quota admission and reservation;
- multi-budget all-or-nothing transactions;
- liability transitions, renewable/resumable leases, expiry recovery;
- idempotency and ambiguous-acknowledgement handling;
- provider-neutral observability contracts;
- adapters that preserve these invariants.

Out of scope for the core runtime:

- generic request rate limiting;
- payment processing and subscription billing;
- invoice/financial-ledger storage;
- OAuth/authentication providers;
- generic MCP gateway/routing products.

External systems may integrate at explicit boundaries, but they do not become a fallback source of quota truth.

## Current state

### Completed foundations

- atomic multi-budget core semantics;
- pending -> cost-liable -> settled lifecycle;
- renewable leases and conservative expiry recovery;
- bounded idempotency tombstones and settlement replay semantics;
- Redis production store and Cloudflare Durable Objects + SQLite store;
- provider-neutral observability lifecycle;
- MCP v2 single-round wrapper;
- MCP v2 `input_required` suspend/resume accounting with verified request state and one-time server-side flow consumption (#14, completed);
- real Monokura -> GCP -> Cloudflare Durable Objects dogfood of the core remote accounting path.

## Priority 1 — production multi-round flow storage and reconciliation

Tracked in #41.

The generic `McpUsageFlowStore` contract exists, but `MemoryMcpUsageFlowStore` is process-local. Production horizontally scaled MCP servers need at least one shared/durable implementation with atomic compare-and-consume semantics.

Requirements:

- mismatch never consumes a legitimate suspended flow;
- one resume token permits at most one application re-entry;
- storage failure remains fail-closed;
- post-claim process/transport loss does not trigger blind handler replay;
- optional completed-result reconciliation, if added, stays separate from usage accounting and remains bounded;
- destructive/external side effects continue to use business idempotency unless a compatible result-reconciliation layer is explicitly configured.

Redis is the natural first adapter candidate because the repository already has a Redis production dependency and atomic Lua transaction model.

## Priority 2 — real Cloudflare operational closure

Tracked in #24.

The deployed Free-plan dogfood path has exercised reserve, liability, renewal, settlement, contention, retry/lost-ACK behavior, and fail-close operation. Remaining closure conditions are real-platform observations that local workerd cannot prove:

- execute the documented credential rotation against the real dogfood deployment and verify old-credential rejection/new-credential success;
- capture a genuine Cloudflare platform-limit / overload / Free-plan exhaustion event and confirm it remains operationally distinct from business `quota_exceeded`.

Do not intentionally burn shared Free-plan quota merely to satisfy the second observation.

## Priority 3 — third-party store invariant test kit

A future adapter should not be considered compatible merely because it implements the `UsageStore` method names. Provide a reusable conformance suite that executes the transactional contract against a candidate store.

The kit should cover at minimum:

- parallel final-unit contention;
- all-or-nothing multi-budget denial;
- duplicate logical operation handling;
- pending expiry release;
- liable expiry retention;
- renew across the original lease boundary;
- identical settlement replay and conflicting settlement rejection;
- lost/ambiguous reserve and settlement acknowledgement expectations;
- bounded tombstone reuse;
- storage-failure fail-close behavior.

Store-specific durability/failover behavior remains documented separately from atomic in-process semantics.

## Priority 4 — external billing / metering adapter boundary

Provider-specific billing export may be useful, but it must remain downstream of enforcement.

Preferred shape:

```text
UsageControl / UsageStore
        |
        v
stable provider-neutral events
        |
        +--> optional billing adapter
        +--> optional telemetry adapter
        +--> durable reconciliation pipeline
```

Rules:

- billing provider schemas do not enter `UsageStore.reserve()` transaction semantics;
- observer delivery failure never turns allow into deny or deny into allow;
- an external ledger is not dynamically substituted as quota truth after Redis/Cloudflare failure;
- stable idempotency keys are used downstream where duplicate event delivery is possible;
- financial-grade retention/reconciliation remains an application/integration responsibility, not a claim made by the enforcement core.

## Deferred — first npm publication

Tracked in #6.

GitHub/source `v0.1.0` exists, while npm publication remains intentionally deferred. Do not publish merely to close the issue.

When publication is explicitly desired:

1. verify package-name availability/ownership;
2. freeze/review the final public core/MCP/Redis/Cloudflare contracts;
3. configure/verify npm Trusted Publishing/bootstrap credentials;
4. run the manual publish workflow with explicit confirmation;
5. verify registry metadata and clean-consumer installation.

Until then, repository checkout/local tarballs remain the supported dogfood path.

## Non-goals that should stay non-goals

Unless a separate project is deliberately created, do not turn `mcp-usage-control` into:

- a generic workflow engine;
- a full MCP gateway;
- a generic rate limiter;
- a payment/subscription platform;
- an invoice/financial ledger;
- an authentication system.

The project should grow by making the transactional enforcement boundary more portable, testable, observable, and recoverable—not by absorbing adjacent products.
