# Operational usability

[日本語](operational-usability.ja.md)

v0.10 adds small, provider-neutral helpers for operations without creating a second accounting truth. Enforcement state remains authoritative in the configured `UsageStore`.

## Operational snapshot

Use `UsageOperationalMonitor` as the same best-effort observer passed to the runtime and Store:

```ts
import { MemoryUsageStore, UsageControl } from 'mcp-usage-control';
import {
  UsageOperationalMonitor,
  createUsageRuntimeIdentity,
} from 'mcp-usage-control/operational';

const monitor = new UsageOperationalMonitor(
  createUsageRuntimeIdentity({
    provider: 'memory',
    capabilities: ['progressive', 'vector', 'reconciliation'],
  }),
);

const store = new MemoryUsageStore({ observer: monitor });
const control = new UsageControl(store, policy, { observer: monitor });

console.log(JSON.stringify(monitor.snapshot()));
```

The snapshot contains only bounded process-local lifecycle counters, phase-specific error counts, optional static runtime identity, and the last observed event timestamp. It does not contain principal IDs, operation IDs, reservation IDs, tool names, budget keys, raw errors, or tool arguments.

The counters are **non-authoritative telemetry**. Event replay can repeat lifecycle events, and process restarts reset process-local counters. Do not derive quota balances, billing totals, or replay decisions from the snapshot.

`MCP_USAGE_CONTROL_VERSION` is exported from the operational subpath and is kept aligned with the core package manifest. `createUsageRuntimeIdentity()` also accepts a static provider mode, bounded capability flags, and an optional storage schema version. Only expose a storage schema version when the provider gives that value a stable documented meaning; otherwise omit it.

### Retention is not quota state

`MemoryUsageStore.stats()` reports retained bookkeeping resources. It does not mean "active billable operations" and it is not an authoritative remaining-quota view. Keep retention/resource health separate from lifecycle telemetry and scoped accounting balances.

Do not publish one global `consumedUnits` metric across unrelated budgets or vector dimensions. The same reservation can participate in multiple budgets, and unlike vector dimensions must remain semantically distinct.

## Explicit scoped quota projection

Authoritative `remaining` is meaningful only after the application selects the exact budget/window it owns. Project that selected balance explicitly:

```ts
import { projectScopedQuota } from 'mcp-usage-control/operational';

const admission = await control.reserve(request);
if (admission.allowed) {
  const daily = admission.remainingByBudget.find(item => item.key === dailyBudget.key);
  if (daily) {
    const quota = projectScopedQuota(dailyBudget.limit, daily.remaining);
    // { limit, remaining, used, exhausted, utilization }
  }
}
```

The helper deliberately receives no budget key. Window naming, reset rules, and selection of the authoritative balance stay application-owned.

## Canonical settlement outcomes

Normalize domain-specific outcomes before crossing the usage boundary:

```ts
import {
  InvalidSettlementOutcomeError,
  normalizeSettlementOutcome,
} from 'mcp-usage-control/settlement-outcomes';

const outcome = normalizeSettlementOutcome('invalid_browser_request', {
  invalid_browser_request: 'invalid_arguments',
});

await lease.settle(0, outcome);
```

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

The default alias map keeps bounded compatibility for existing generic adapter values such as `success`, `tool_error`, and `error`.

Invalid vocabulary throws `InvalidSettlementOutcomeError` with bounded code `invalid_settlement_outcome`. The raw invalid value is not retained in the error. This lets an integration distinguish a local vocabulary/configuration bug from Store/backend unavailability without weakening fail-closed settlement behavior.

Settlement normalization does not decide whether work is refundable. The application must map provider evidence to the canonical outcome and actual units. An ambiguous post-dispatch failure must not be converted to `proven_no_effect` merely because the provider call returned an error.

## Threshold and exhaustion signals

Threshold helpers operate only on an explicitly scoped quota snapshot:

```ts
import { projectScopedQuota } from 'mcp-usage-control/operational';
import {
  didUsageQuotaThresholdCross,
  evaluateUsageQuotaThreshold,
} from 'mcp-usage-control/thresholds';

const previous = projectScopedQuota(100, 25);
const current = projectScopedQuota(100, 20);
const threshold = { kind: 'remaining_ratio', value: 0.2 } as const;

if (didUsageQuotaThresholdCross(previous, current, threshold)) {
  await applicationOwnedAlertSink('quota-low');
}

const state = evaluateUsageQuotaThreshold(current, threshold);
```

Supported threshold forms are:

- `{ kind: 'remaining_units', value: N }`
- `{ kind: 'remaining_ratio', value: 0..1 }`

`didUsageQuotaThresholdCross()` returns `true` only for an above -> reached transition. Replaying the same authoritative balance therefore does not create another crossing. The caller must retain the previous state for the relevant accounting window and reset that state when the application-owned window changes. A changed configured limit is rejected by the crossing helper instead of being guessed as the same window.

Use `{ kind: 'remaining_units', value: 0 }` for exhaustion crossing.

Slack, email, webhooks, queues, deduplication persistence, and notification retry policy stay outside the core package. A failed alert sink must never change admission or settlement.

## Safety summary

- Store/accounting state remains the only enforcement authority.
- Operational counters are process-local, bounded, and non-authoritative.
- Scoped remaining values require explicit application-owned budget/window selection.
- Settlement vocabulary errors are distinguishable from service failures without exposing the bad raw value.
- Threshold helpers are pure; accounting-window state and alert delivery stay application-owned.
- No helper infers entitlement, pricing, subscription lifecycle, or reset windows.
