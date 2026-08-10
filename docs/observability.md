# Observability

[English](observability.md) | [日本語](observability.ja.md)

`mcp-usage-control` exposes provider-neutral structured lifecycle events. Observability is intentionally **outside the enforcement transaction**: an observer may log, meter, trace, or forward events, but it is never the source of quota truth.

## Configure an observer

Use the same observer for `UsageControl` and the store if you want both runtime lifecycle events and store-level expiry recovery events:

```ts
import {
  UsageControl,
  type UsageEvent,
  type UsageObserver,
} from 'mcp-usage-control';
import { RedisUsageStore } from 'mcp-usage-control-redis';

const observer: UsageObserver = {
  onEvent(event: UsageEvent) {
    console.log(JSON.stringify(event));
  },
};

const store = new RedisUsageStore(redis, { observer });
const control = new UsageControl(store, policy, {
  observer,
  metadata: {
    service: 'my-mcp-server',
    environment: 'staging',
  },
});
```

`metadata` is explicit opt-in data. It can also be a callback receiving the usage request. Do not put secrets, tokens, raw tool arguments, provider payloads, or unbounded user content in metadata.

Policy denial `reason` values are also application-defined and are copied into `reserve.denied`. Treat them as bounded non-secret reason codes, not free-form diagnostic text.

The legacy numeric third constructor argument remains accepted:

```ts
new UsageControl(store, policy, 60_000);
```

## Event types

### `reserve.accepted`

Emitted after the store atomically reserves every applicable budget.

Includes request identity fields, `reservationId`, `budgetKeys`, `reservedUnits`, and `remainingByBudget`.

### `reserve.denied`

Emitted for policy denial, quota denial, and duplicate-operation denial.

Quota denial may include `limitingBudgetKey` and `remaining`.

### `settlement.completed`

Emitted after a successful store settlement, including an identical idempotent settlement replay.

Includes reserved, actual, and released units plus the settlement outcome.

### `reservation.recovered`

Emitted when an expired lease is recovered.

- `pending_released`: capacity was released because execution never became cost-liable.
- `liable_retained`: the full reservation was conservatively retained because execution had already started.

The memory reference store can report the local reservation/request identifiers it already holds. The Redis store intentionally does **not** persist raw principal, tenant, tool, or budget strings just to improve telemetry. Lazy Redis cleanup therefore emits aggregate recovery events containing `count` and aggregate `reservedUnits`. If an expired Redis reservation is touched directly, its opaque hashed reservation ID may also be included.

### `operation.error`

Emitted when policy quote or store reserve/mark-liable/renew/settle throws.

Only a bounded constructor class name is included. Raw exception messages and mutable `Error.name` values are deliberately omitted because they can contain credentials, internal URLs, query text, provider response bodies, or unbounded high-cardinality text.

## Delivery semantics

Observer delivery is:

- best-effort;
- outside the enforcement outcome;
- not awaited when `onEvent()` returns a promise;
- not ordered across concurrent calls;
- not retried by the runtime;
- not durable;
- never allowed to change an admission or settlement result.

`onEvent()` is invoked inline. Keep synchronous work lightweight; offload network calls, durable writes, and expensive serialization to an application-owned queue or telemetry pipeline. A returned promise is not awaited. Synchronous throws and asynchronous promise rejections are swallowed.

If durable analytics or billing reconciliation is required, send events to a durable queue/ledger from application code and monitor that pipeline independently. The usage store remains the source of enforcement truth.

## Replay and deduplication

Observability is **at-least-possibly-repeated**, not exactly-once. For example, Redis makes an identical settlement replay idempotent at the enforcement state layer, but calling `settle()` again can emit another identical `settlement.completed` event.

If a downstream counter or durable pipeline must avoid double counting, deduplicate settlement events using a stable application key such as:

```text
(reservationId, actualUnits, outcome)
```

Keep the dedupe horizon at least as long as the retry/reconciliation horizon relevant to that pipeline. Do not infer quota truth by counting events; query/reconcile the enforcement or durable accounting state instead.

## Privacy and cardinality

Tool arguments are never copied into events automatically. Raw exception messages are not copied either.

Runtime events can contain `principalId`, `tenantId`, `operationId`, `reservationId`, tool names, and budget keys. Treat these as potentially sensitive/high-cardinality fields.

Recommended usage:

- structured logs / traces: IDs may be useful when allowed by your privacy policy;
- metrics: use bounded dimensions such as tool, outcome, plan, denial reason code, or error class;
- **do not** promote unique principal, operation, reservation, or user-specific budget IDs into metric labels/tags.

This avoids cardinality explosions in Prometheus, Cloud Monitoring, Datadog, OpenTelemetry metric backends, and similar systems.

## Suggested counters

The event stream is suitable for deriving bounded operational counters such as:

- accepted calls by tool/plan;
- denied calls by reason/tool/plan;
- consumed units by tool/outcome;
- released units;
- pending-expiry recoveries;
- liable-expiry retained units;
- store/state errors by phase/error class.

Apply replay deduplication where needed. Do not use these counters as the transactional quota balance. They are operational views over enforcement events.

## Cloudflare recovery telemetry

`CloudflareUsageStore` / `RemoteCloudflareUsageStore` can emit `reservation.recovered` with `store: 'cloudflare'`. Lazy cleanup emits aggregate counts/units; directly addressed expiry can include only the opaque hashed reservation ID. Raw principal, tenant, tool, operation, budget, and tool-argument values are not persisted by the Cloudflare backend solely for recovery telemetry.

## Vendor adapters

The core runtime does not depend on OpenTelemetry, OpenMeter, Datadog, Cloud Monitoring, GA4, or any billing provider. Add those integrations in application code or future optional adapters.

See also [Architecture](architecture.md), [API reference](api-reference.md), [Redis adapter](redis.md), and [Security policy](../SECURITY.md).
