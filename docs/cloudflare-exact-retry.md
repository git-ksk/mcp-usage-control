# Cloudflare exact post-reserve retry

[English](cloudflare-exact-retry.md) | [日本語](cloudflare-exact-retry.ja.md)

`mcp-usage-control-cloudflare/exact-retry` is an optional wrapper for one narrow recovery case: replaying the **exact same scalar post-reserve transition** after a retryable transport failure.

It does not change the base `RemoteCloudflareUsageStore` behavior. The base client still performs one network attempt per method call.

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
} from 'mcp-usage-control-cloudflare/exact-retry';

const remote = new RemoteCloudflareUsageStore({
  endpoint: process.env.USAGE_STORE_URL!,
  headers: () => ({
    authorization: `Bearer ${process.env.USAGE_STORE_TOKEN!}`,
  }),
});

const store = createExactRetryingRemoteCloudflareUsageStore(remote, {
  // Total calls including the initial attempt. Default: 2. Allowed: 1..4.
  maxAttempts: 2,
});
```

`maxAttempts: 2` means at most one exact replay. `maxAttempts: 1` disables retry without changing the wrapper shape.

For eligible methods, the helper snapshots the scalar input before the first attempt and reuses that snapshot. It never changes the reservation ID, TTL, actual units, or settlement outcome between attempts.

`renew()` TTL is relative to the Store clock. If the first renewal committed but its acknowledgement was lost, an exact replay can move `expiresAt` forward again. This is conservative for quota capacity (it may retain capacity longer) and does not create another reservation or increase reserved units.

## What this does not prove

A retry that eventually succeeds proves only that the exact state transition is now represented by the Store. It does not prove whether the first transport attempt committed before its acknowledgement was lost.

A conflicting exact replay remains an error. The helper never converts an unknown or conflicting result into success and does not log raw reservation, operation, or budget identifiers.

For ambiguous initial reserve, see [Cloudflare reserve reconciliation](cloudflare-reserve-reconciliation.md).
