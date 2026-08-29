# Cost-bearing operations

[English](cost-bearing-operations.md) | [日本語](cost-bearing-operations.ja.md)

This document defines the v0.11 contract for provider-backed work that may create real marginal cost, such as AI inference, paid APIs, document processing, or other metered external services.

The v0.11 decision is deliberately conservative: **no new public accounting primitive is required.** The existing vector reservation, liability, progressive growth, renewal, settlement, and idempotency contracts are sufficient when they are composed at the correct execution boundaries.

## Frozen lifecycle

A cost-bearing operation should follow this sequence:

```text
resolve trusted caller + application-owned accounting scope
  -> quote bounded maximum exposure
  -> atomically reserve every required dimension
  -> mark liable immediately before billable dispatch
  -> dispatch provider work
  -> grow before any additional billable exposure
  -> renew while authoritative work/evidence is still pending
  -> settle authoritative actual usage
```

A refund/release is allowed only when the application can prove that the reserved exposure did not create a billable effect. A provider error, timeout, cancelled client request, or missing acknowledgement after dispatch is not by itself proof of zero cost.

## Reserve maximum exposure, not expected average cost

`mcp-usage-control` does not allow settlement above successfully reserved capacity. That is a safety property, not an inconvenience to work around.

For variable-cost provider work, the application must therefore do one of the following before dispatch:

1. reserve a defensible maximum exposure for the attempt; or
2. reserve an initial bounded amount and call `grow()` **before** any later provider action can create additional exposure.

An expected or average provider cost is not a hard budget bound when the actual cost can exceed it.

If no defensible maximum exists and the provider can continue accumulating cost without a controllable pre-growth boundary, the application must not claim that this usage reservation provides a hard provider-spend cap.

## Keep unlike units in separate vector dimensions

Count quota and provider cost are different units and should not be added into one synthetic scalar.

For example:

```ts
const policy = {
  quote() {
    return {
      decision: 'allow',
      dimensions: [
        {
          key: 'operations',
          units: 1,
          budgets: [{ key: 'count:scope:workspace-42', limit: 100 }],
        },
        {
          key: 'provider_cost_microunits',
          units: 1_000,
          budgets: [{ key: 'cost:scope:workspace-42', limit: 50_000 }],
        },
      ],
    };
  },
};
```

Use safe integer/fixed-scale application units for provider cost, such as microunits or another documented integer scale. Currency conversion, provider pricing tables, taxes, billing-period semantics, and financial reconciliation remain application-owned.

## Caller identity and accounting scope are different concepts

`Principal` remains the trusted caller identity used for operation idempotency and isolation. The entity whose budget pays for the operation may be different.

The application selects that accounting scope before quoting and encodes it in opaque application-owned budget keys. For example, several board members may use different principals while all reservations consume:

```text
cost:scope:board-owner-42
```

This does not make `mcp-usage-control` authoritative for subscription ownership, membership, entitlement, or billing. The application must resolve those facts before constructing the policy/budget keys.

No new `subscriptionId`, `billingAccountId`, or `budgetScopeId` field is added to core for v0.11 because the existing `Budget.key` boundary already represents an application-selected accounting bucket without embedding product semantics.

## Liability boundary

Call `markLiable()` immediately before the first action that may incur provider cost.

```text
reserve succeeded
  -> markLiable succeeded
  -> provider dispatch is permitted
```

If `markLiable()` fails or its acknowledgement is ambiguous, local intent is not proof that the authoritative liability transition succeeded. Do not proceed with billable dispatch merely because the application attempted the call; fail closed until the integration has an authoritative safe path.

Once a reservation is liable, expiry no longer implies a refund. If actual usage is unknown, the reserved exposure is retained conservatively.

## Provider retries are additional exposure

A provider retry that can independently incur cost is not a free retry.

Before the next billable attempt:

```text
first attempt may have incurred cost
  -> reserve/grow maximum exposure for retry
  -> only if growth is authoritatively accepted
  -> dispatch retry
```

For vector reservations, a retry can grow only the provider-cost dimension while adding zero to a count dimension when product policy says the logical operation should still count once.

If `grow()` is denied, the additional provider attempt must not be dispatched. If growth returns an ambiguous provider/storage error, `UsageLease`/`VectorUsageLease` pins the unresolved growth attempt so only the exact same increment can be retried until an authoritative result is obtained. Do not dispatch new billable work while growth remains unresolved.

Provider/business retry policy itself remains outside this library. Usage idempotency does not make a destructive or non-idempotent provider operation safe to replay.

## Settlement and proven no-effect release

Settlement is the authoritative accounting close for the reservation.

Use canonical outcome vocabulary. Typical cost-bearing mappings are:

| Situation | Usage treatment | Canonical outcome |
| --- | --- | --- |
| Rejected before billable dispatch | settle zero when no effect is proven | `pre_dispatch_rejected` or `pre_dispatch_no_effect` |
| Explicitly proven no provider effect | settle proven actual, including zero | `proven_no_effect` |
| Successful provider work with authoritative usage | settle actual dimensions | `completed` |
| Dispatch happened but final cost is unknown | retain/settle conservatively within reserved exposure | `dispatched_conservative` |
| Cancellation after dispatch | do not infer zero cost | `cancelled_after_dispatch` |

A thrown provider exception does not automatically map to `proven_no_effect`. The application must have provider-specific evidence that no billable side effect occurred.

Settlement never accepts actual usage above reserved capacity. If the provider reports more than was reserved, that indicates the application failed to establish a sufficient pre-dispatch bound; it must not silently under-account or mutate the limit after the fact.

## Delayed provider usage evidence

Some providers return final usage later than the primary result.

If the authoritative usage evidence is expected while the reservation can still be retained:

1. keep the authoritative operation active;
2. renew the lease as required;
3. settle when the final bounded usage evidence arrives.

If evidence can arrive only after the reservation can no longer be authoritatively retained, the initial reservation must already cover a defensible maximum and the usage path must remain conservative. Durable post-hoc financial reconciliation belongs in the application/billing ledger, not in `mcp-usage-control`.

## Rate limits, circuit breakers, and kill switches

Cost reservation composes with other controls but does not replace them.

A typical application may evaluate:

```text
application kill switch
  -> provider/global circuit breaker or health policy
  -> short-window rate limit
  -> entitlement/accounting-scope resolution
  -> mcp-usage-control atomic reserve
  -> liability + billable dispatch
```

The exact ordering may depend on whether a control is purely local or authoritative, but no external availability policy should turn an accounting Store failure into an unmetered allow.

Provider health, remote configuration, entitlement resolution, and retry/backoff policy remain application-owned.

## Observability and privacy

Use the existing lifecycle events and operational helpers for bounded signals such as reserve accepted/denied, settlement, recovery, and storage errors.

Do not copy prompts, receipt images/text, provider payloads, credentials, raw tool arguments, customer identifiers, or unrestricted user content into event metadata. Unique operation/principal/reservation/budget identifiers should not become metrics labels.

Operational telemetry is not an accounting authority or financial ledger.

## What the v0.11 proof establishes

The focused core proof covers:

- different callers contending for one application-selected shared accounting scope;
- atomic count + provider-cost reservation;
- bounded maximum exposure before dispatch;
- settlement bounded by reserved capacity and release of unused exposure;
- proven pre-dispatch no-effect release;
- growth before a second billable provider attempt;
- denial of growth preventing that retry dispatch;
- conservative retention after liable/post-dispatch ambiguity;
- stable logical operation identity preventing duplicate reservation.

Provider-specific Store conformance continues to prove the underlying atomic vector/growth/expiry behavior. The cost-bearing proof does not create a second Store contract.

## v1 boundary

For v1, the adopted contract is therefore:

**application-owned entitlement/scope/pricing -> existing atomic vector reservation -> explicit liability -> bounded pre-dispatch growth -> authoritative settlement.**

No provider-specific billing abstraction, financial ledger, subscription model, or new cost-bearing public primitive is part of the v1 core surface unless later evidence demonstrates a safety gap that the current contract cannot represent.
