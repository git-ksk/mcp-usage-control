# v1 public API and lifecycle freeze

This document records the v0.11 decisions that define the intended v1 public surface. v1 promotion may fix bugs or documentation, but should not rename these concepts or tighten them incompatibly without a new compatibility decision.

## Package names

The five public package names are frozen:

- `mcp-usage-control` — core accounting controls, Memory Store, and shared contracts;
- `mcp-usage-control-mcp` — MCP server tool-handler integration;
- `mcp-usage-control-redis` — Redis Store;
- `mcp-usage-control-cloudflare` — Cloudflare Durable Objects Store;
- `mcp-usage-control-firestore` — Firestore Store.

No `@scope`, gateway-oriented rename, billing-oriented rename, or provider-package consolidation is planned for v1.

The core package's existing public subpaths are also retained:

- `mcp-usage-control/operational`
- `mcp-usage-control/settlement-outcomes`
- `mcp-usage-control/thresholds`
- `mcp-usage-control/conformance`

Provider-internal files and undocumented source paths are not public subpaths merely because they exist in the repository.

## Accounting lifecycle terminology

The stable lifecycle vocabulary is:

```text
quote -> reserve -> mark liable -> [grow] -> [renew] -> settle
```

Persisted reservation states remain:

- `pending` — capacity is reserved but metered execution has not crossed the liability boundary;
- `liable` — metered execution may have incurred usage, so unknown expiry is conservative;
- `settled` — the authoritative reservation has reached a terminal accounting result.

`grow` increases already-reserved capacity on the same logical reservation. `renew` extends lease time only. Neither term is interchangeable with retry, re-admission, billing, or reconciliation.

The logical operation identity remains scoped by `(tenantId, principal.id, tool, operationId)` where supported by the Store. Resume never creates a second reservation for the same suspended usage flow.

## Settlement outcome typing decision

### Store and direct lease boundary: intentionally extensible `string`

`SettleInput.outcome`, `SettlementResult.outcome`, `VectorSettleInput.outcome`, `VectorSettlementResult.outcome`, `UsageLease.settle(..., outcome)`, and `VectorUsageLease.settle(..., outcome)` remain `string` in v1.

This is deliberate, not unfinished typing. The Store contract is a low-level idempotent accounting boundary and existing applications may persist domain-specific outcome labels. Tightening that value to a closed union would create source and persisted-replay compatibility pressure without changing reserve/liability/settlement safety.

Settlement replay equality remains exact. An application that uses a custom outcome is responsible for using the same stable value on an identical replay.

### Bounded integration vocabulary: canonical outcomes

When an integration needs portable diagnostics or library-owned lifecycle classification, use `mcp-usage-control/settlement-outcomes` and normalize before settlement.

The canonical vocabulary is:

- `authorization_denied`
- `invalid_arguments`
- `pre_dispatch_rejected`
- `pre_dispatch_no_effect`
- `cancelled_before_dispatch`
- `completed`
- `proven_no_effect`
- `dispatched_conservative`
- `cancelled_after_dispatch`

`normalizeSettlementOutcome()` is the explicit boundary between application/integration aliases and this bounded vocabulary. Unknown values fail with `InvalidSettlementOutcomeError`; diagnostics do not retain the raw unknown input.

The built-in MCP adapter now applies this normalization before Store settlement. Its compatibility aliases therefore remain supported without becoming persisted MCP-specific vocabulary. For example, `success` and `tool_error` normalize to `completed`, while `error` and the conservative `input_required` failure aliases normalize to `dispatched_conservative`.

Direct core callers are not silently normalized. If they want the canonical vocabulary, they must call the normalizer explicitly before `settle()`.

## Scalar/vector parity

Scalar and vector accounting use the same lifecycle concepts:

- reserve before use;
- explicit liability before metered work;
- optional bounded growth;
- lease renewal without capacity change;
- settlement bounded by successfully reserved capacity;
- pending vs liable expiry distinction;
- stable operation replay protection;
- extensible Store outcome strings with the same optional canonical normalization boundary.

Vector APIs keep dimensions explicit. There is no v1 scalarization helper that combines unlike units into one synthetic total.

## Public status and reason vocabulary

Operation reconciliation status is frozen as:

- `absent`
- `active`
- `expired`
- `settled`

`active` and `expired` carry reservation state `pending | liable` where applicable. `absent` remains a retained-state observation, not proof that a historical operation never existed.

Admission denial reasons owned by the built-in Store contract remain:

- `quota_exceeded`
- `duplicate_operation`

Progressive/vector growth uses `quota_exceeded` for a definitive capacity denial. Provider ambiguity is an exception/fail-closed condition, not another denial reason.

Recovery vocabulary remains:

- `pending_released`
- `liable_retained`

These terms describe authoritative recovery behavior; they are not billing/payment statuses.

## Error vocabulary

Core public errors retain their current roles:

- `UsageDeniedError` — policy/admission denial surfaced by wrappers;
- `UsageStateError` — authoritative state mismatch, invalid lifecycle transition, unsupported/corrupt Store state, or other fail-closed state rejection;
- `MemoryUsageStoreCapacityError` — bounded Memory Store retention capacity;
- `InvalidSettlementOutcomeError` — bounded canonical-outcome normalization failure.

MCP adapter errors retain their current roles:

- `UsageSettlementError` — settlement failed and may be ambiguous;
- `UsageClassificationError` — cost classification failed and conservative settlement was attempted;
- `UnsupportedMcpUsageFlowError` — single-round wrapper encountered `input_required`;
- `McpUsageResumeError` — resume state missing, invalid, expired, replayed, or binding-mismatched;
- `McpUsageRoundsExceededError` — configured multi-round limit exceeded.

Provider SDK/network error names are not promoted into a stable cross-provider public enum. Ambiguous provider failures continue to propagate/fail closed unless a provider-specific authoritative reconciliation rule exists.

## MCP multi-round scope

The public multi-round terminology remains `protectMultiRoundTool()`, `McpUsageFlowStore`, `McpUsageFlowRecord`, `McpUsageFlowBinding`, `McpUsageFlowContext`, and request-state mint/verify integration.

No separate public `MRTR` accounting state machine is added for v1. MCP suspended-flow storage controls resume integrity and one-time flow consumption; the underlying usage reservation remains the accounting authority.

Business task/result persistence, payment state, provider result replay, and application workflow state remain outside this package's usage-accounting authority.

## Naming and compatibility rule after freeze

For v1:

- additive helpers may be considered only when they do not redefine the frozen accounting lifecycle;
- a rename should use a documented compatibility alias/deprecation path rather than silently replacing a public name;
- persisted provider state follows the separate [persisted-state compatibility contract](persisted-state-compatibility.md);
- a provider implementation may expose provider-specific diagnostics, but cross-provider core vocabulary must not claim semantics the provider cannot prove;
- npm publication remains a separate explicit authorization and does not change this API decision.
