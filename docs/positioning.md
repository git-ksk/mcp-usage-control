# Project positioning

[English](positioning.md) | [日本語](positioning.ja.md)

`mcp-usage-control` is a **failure-safe transactional usage-enforcement library for MCP servers**.

Its purpose is not merely to count requests or attach a budget to an agent. The project exists to preserve usage/quota invariants when real systems experience concurrency, retries, process loss, lease expiry, and acknowledgement ambiguity.

## Core promise

The core lifecycle is:

```text
policy/entitlement -> quote -> atomic reserve -> mark liable -> execute -> settle
                                                   ^                 |
                                                   |------ renew -----|
```

The differentiating contract is the combination of:

- atomic all-or-nothing admission before metered work starts;
- an explicit `pending -> cost-liable` transition;
- state-dependent expiry recovery;
- conservative treatment of crash/lost-ACK ambiguity after execution may have started;
- idempotent logical-operation replay and conflicting-settlement rejection;
- MCP-aware single-round and multi-round integration without a second reservation;
- provider-neutral stores and observability that do not become a billing source of truth.

This is a correctness layer around execution, not a general budget-management product.

## Why `cost-liable` matters

A reservation that expires before metered work starts may safely release capacity. A reservation that expires after the execution boundary has been entered is different: the system may no longer be able to prove whether an upstream API, database, compute job, or other metered resource was consumed.

`mcp-usage-control` therefore keeps these cases distinct:

```text
pending lease expires      -> release reserved capacity
cost-liable lease expires  -> retain the conservative full charge
```

That trade-off intentionally favors quota correctness over optimistic availability when the execution outcome is unknown.

## Competitive boundary

The project should not try to outgrow broader agent-budget, gateway, billing, or governance platforms by copying their product surface.

Those systems may provide valuable capabilities such as dashboards, pricing catalogs, organization-wide budget administration, payment flows, routing, policy engines, or multi-language agent integrations. They are adjacent or partially overlapping categories, not a roadmap template for this library.

`mcp-usage-control` should remain narrow and embeddable. Its strongest position is:

> **Preserve transactional usage invariants at the MCP execution boundary, especially under failure and retry.**

Features should be evaluated against that position. A feature belongs in core only when it strengthens admission, liability, settlement, replay, recovery, or the MCP execution boundary without turning the project into a gateway or billing platform.

For a maintained evidence-based comparison with adjacent products, see [Competitive capability map](competitive-capabilities.md).

## MCP-native direction

MCP-specific work should focus on protocol semantics that affect accounting correctness, including:

- explicit conformance with the current MCP protocol/SDK behavior;
- fresh-request multi-round retries without duplicate reservation;
- integrity-verified request state and trusted principal/tool/argument rebinding;
- horizontally scalable resume/reconciliation semantics;
- long-running MCP Tasks where task lifetime must remain tied to reservation/lease lifetime;
- stateless-friendly designs where they preserve the same accounting guarantees.

A stateless transport model does not imply stateless accounting. Shared state is acceptable where atomic quota enforcement requires it; the goal is to avoid unnecessary session affinity or workflow state in the MCP adapter.

## What should remain outside core

The core should not become:

- a generic agent runtime or agent budget authority;
- a generic HTTP/API rate limiter;
- an MCP gateway/router;
- a payment processor, checkout system, or subscription manager;
- a billing dashboard or pricing catalog;
- an OAuth/identity provider;
- a financial-grade ledger;
- a vendor-specific billing/metering protocol implementation;
- a workflow engine for replaying arbitrary business side effects.

Adapters may integrate with these systems, but their terminology or delivery guarantees must not weaken atomic admission, liability, replay, expiry, or settlement semantics.

## Roadmap test

Before adding a major feature, ask:

1. Does it make quota admission or settlement safer under concurrency, retry, crash, or ambiguous acknowledgement?
2. Does it improve MCP-native correctness without requiring gateway ownership?
3. Can it remain provider-neutral at the core state-machine boundary?
4. Does it preserve the explicit `cost-liable` invariant?
5. Would a third-party store compatibility test be able to verify the relevant guarantee?

If the answer is mostly no, the feature probably belongs in an adapter, example, or another project rather than this core runtime.
