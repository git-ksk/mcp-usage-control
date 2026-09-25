# Cloudflare exact post-reserve retry

[English](cloudflare-exact-retry.md) | [日本語](cloudflare-exact-retry.ja.md)

`mcp-usage-control-cloudflare/exact-retry` is an optional wrapper for one narrow recovery case: replaying the **exact same scalar post-reserve transition** after a retryable transport failure.

It does not change the base `RemoteCloudflareUsageStore` behavior. The base client still performs one network attempt per method call.

This helper stays in the Cloudflare package rather than the provider-neutral core because retry eligibility depends on `CloudflareUsageTransportError` and HTTP status classes. The core `UsageStore` contract remains transport-agnostic.

## Safety boundary

The wrapper retries only:

- `markLiable()`
- `renew()`
- `settle()`

It does **not** retry:

- initial `reserve()`
- `reserveVector()`
- scalar/vector growth
- vector settlement

Ambiguous initial reserve must use the separate read-only operation-reconciliation path. Never replace reserve reconciliation with retry middleware.

The retryable transport set is intentionally narrow:

- local timeout
- network failure
- HTTP `408`
- HTTP `429`
- HTTP `5xx`

Authentication failures, ordinary `4xx`, protocol validation failures, Store conflicts, and other application errors are returned immediately.

## Usage

```ts
import { RemoteCloudflareUsageStore } from 'mcp-usage-control-cloudflare';
import {
  createExactRetryingRemoteCloudflareUsageStore,
  type RemoteCloudflareExactRetryObserver,
} from 'mcp-usage-control-cloudflare/exact-retry';

const remote = new RemoteCloudflareUsageStore({
  endpoint: process.env.USAGE_STORE_URL!,
  headers: () => ({
    authorization: `Bearer ${process.env.USAGE_STORE_TOKEN!}`,
  }),
});

const retryObserver: RemoteCloudflareExactRetryObserver = {
  onEvent(event) {
    console.info(JSON.stringify(event));
  },
};

const store = createExactRetryingRemoteCloudflareUsageStore(remote, {
  // Total calls including the initial attempt. Default: 2. Allowed: 1..4.
  maxAttempts: 2,
  // Equal-jitter exponential backoff. Defaults: 100ms base, 1000ms cap.
  initialBackoffMs: 100,
  maxBackoffMs: 1_000,
  observer: retryObserver,
});
```

`maxAttempts: 2` means at most one exact replay. `maxAttempts: 1` disables retry without changing the wrapper shape. Before each eligible retry, the helper waits using bounded exponential **equal jitter**: the first retry uses 50-100% of `initialBackoffMs`, later retries double the base until `maxBackoffMs`. Defaults are 100ms and 1000ms. Both delay values are bounded to 1..60000ms.

For eligible methods, the helper snapshots the scalar input before the first attempt and reuses that snapshot. It never changes the reservation ID, TTL, actual units, or settlement outcome between attempts.

Backoff is applied only after a transport failure has already been classified retryable and only when another attempt remains. Authentication failures, protocol errors, conflicts, ordinary 4xx responses, and every single-attempt method return without retry delay.

`renew()` TTL is relative to the Store clock. If the first renewal committed but its acknowledgement was lost, an exact replay can move `expiresAt` forward again. This is conservative for quota capacity (it may retain capacity longer) and does not create another reservation or increase reserved units.

## Operational retry telemetry

The optional retry observer is separate from provider-neutral core `UsageObserver` because retry eligibility and transport classification are Cloudflare/HTTP-specific. It emits only bounded fields:

- `retry.scheduled`: phase, next attempt, max attempts, bounded transport class, selected backoff delay;
- `retry.recovered`: phase and total attempts after a retry succeeds;
- `retry.failed`: phase, total attempts, and a bounded terminal reason; an exhausted retryable transport may also include its bounded transport class.

Transport classes are limited to `timeout`, `network`, `http_408`, `http_429`, and `http_5xx`. Events never include reservation/operation/principal/tenant/budget identifiers, tool arguments, endpoint URLs, auth material, raw error objects/messages, response bodies, or arbitrary HTTP metadata.

Delivery is best-effort and outside accounting/enforcement. `onEvent()` is invoked inline, returned promises are not awaited, and synchronous throws or asynchronous rejections are swallowed. Keep synchronous observer work lightweight and offload network/durable I/O yourself.

No retry telemetry is emitted for initial reserve, vector/growth paths, or a failure that is rejected before any retry is scheduled.

Suitable bounded metric dimensions include event type, phase, transport class, and terminal reason. Treat attempts and delay as numeric values rather than introducing raw identifiers into labels.

## What this does not prove

A retry that eventually succeeds proves only that the exact state transition is now represented by the Store. It does not prove whether the first transport attempt committed before its acknowledgement was lost.

A conflicting exact replay remains an error. The helper never converts an unknown or conflicting result into success and does not log raw reservation, operation, or budget identifiers.

For ambiguous initial reserve, see [Cloudflare reserve reconciliation](cloudflare-reserve-reconciliation.md).
