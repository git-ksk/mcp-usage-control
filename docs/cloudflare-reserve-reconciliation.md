# Cloudflare reserve acknowledgement reconciliation

`RemoteCloudflareUsageStore` intentionally does not automatically retry a failed `reserve()` request. A timeout or network failure can be ambiguous: the Durable Object may have committed the reservation even though the caller did not receive the acknowledgement.

The optional reconciliation API provides a **read-only** lookup for that case. It never creates, renews, releases, or settles quota state.

v0.8 shares this result vocabulary with core `UsageOperationReconciliation` and exposes `reconcileRemoteCloudflareOperation()` as the generic entry point. The former `reconcileRemoteCloudflareReserve()` name remains exported as a v0.7-compatible alias.

## Gateway setup

Use the reconciliable gateway wrapper instead of the base gateway when explicit reserve reconciliation is required:

```ts
import { createReconciliableCloudflareUsageStoreGateway } from 'mcp-usage-control-cloudflare/reconciliation';

const usageHandler = createReconciliableCloudflareUsageStoreGateway({
  namespace: env.USAGE_CONTROL,
  domainName: 'production',
  authorize: request =>
    request.headers.get('authorization') === `Bearer ${env.USAGE_GATEWAY_TOKEN}`,
});
```

The wrapper delegates normal `reserve`, `mark_liable`, `renew`, and `settle` requests to the existing gateway unchanged and adds one authenticated `lookup` operation.

## Client procedure

Keep the trusted logical operation identity, expected currently retained scalar units, and budget identities. For initial reserve lost-ACK recovery, this is the exact original reserve input. After an ambiguous `CloudflareUsageTransportError` such as `network` or `timeout`, explicitly reconcile it:

```ts
import { reconcileRemoteCloudflareOperation } from 'mcp-usage-control-cloudflare/reconciliation';

const result = await reconcileRemoteCloudflareOperation(
  {
    endpoint: process.env.MCP_USAGE_CLOUDFLARE_URL!,
    headers: () => ({
      authorization: `Bearer ${process.env.MCP_USAGE_CLOUDFLARE_TOKEN!}`,
    }),
  },
  {
    request: originalRequest,
    units: originalUnits,
    budgets: originalBudgets,
  },
);
```

Do not use reconciliation as generic retry middleware. It is an explicit recovery step after a reserve result became ambiguous.

## Canonical lost-ACK flow

The safe consumer sequence is:

```text
reserve once
  -> acknowledged success: continue normally
  -> definite business denial: stop normally
  -> ambiguous network/timeout: lookup once
       -> active/pending: reattach the same reservation, then continue once
       -> active/liable: do not execute again; recover already-started work
       -> settled: do not execute again
       -> expired/absent: fail closed according to the application recovery horizon
       -> lookup transport/protocol failure: fail closed
```

A concrete `active/pending` recovery can use `UsageControl.resumeLease()` without calling policy or `reserve()` a second time:

```ts
import { UsageControl } from 'mcp-usage-control';
import {
  CloudflareUsageTransportError,
  RemoteCloudflareUsageStore,
} from 'mcp-usage-control-cloudflare';
import { reconcileRemoteCloudflareOperation } from 'mcp-usage-control-cloudflare/reconciliation';

const remoteOptions = {
  endpoint: process.env.MCP_USAGE_CLOUDFLARE_URL!,
  headers: () => ({
    authorization: `Bearer ${process.env.MCP_USAGE_CLOUDFLARE_TOKEN!}`,
  }),
};
const store = new RemoteCloudflareUsageStore(remoteOptions);
const control = new UsageControl(store, policy);

const reserveInput = {
  request,
  units,
  budgets,
  ttlMs,
};

try {
  const reserved = await store.reserve(reserveInput);
  // Handle the normal acknowledged StoreReserveResult here.
  void reserved;
} catch (error) {
  const ambiguous =
    error instanceof CloudflareUsageTransportError &&
    (error.code === 'network' || error.code === 'timeout');
  if (!ambiguous) throw error;

  const reconciled = await reconcileRemoteCloudflareOperation(remoteOptions, reserveInput);

  if (reconciled.status === 'active' && reconciled.state === 'pending') {
    const lease = control.resumeLease({
      reservation: reconciled.reservation,
      ttlMs: reserveInput.ttlMs,
    });

    // Re-check any application-level "work not already started" invariant first.
    await lease.markLiable();
    // execute business work exactly once
    await lease.settle(actualUnits, boundedOutcomeCode);
  } else if (reconciled.status === 'active' && reconciled.state === 'liable') {
    // Never execute the business operation again. Reconcile already-started work,
    // then use the recovered reservation only for renew/settle as appropriate.
  } else {
    // settled / expired / absent are not permission to retry execution.
    throw new Error('reserve reconciliation did not prove a safe pending continuation');
  }
}
```

The explicit branch is intentional. A helper that silently converts every reconciliation state back into a successful reserve would hide ambiguity and make duplicate business execution easier.

A business `duplicate_operation` response is different from a lost ACK. It is a definite store result saying that the logical operation key is already protected; do not interpret it as the original reserve result and do not blindly retry it.

## Result states

### `active` / `pending`

The original reserve committed and is still active, while `markLiable` has not been recorded. The API reconstructs the original `ReservationRecord` locally so the caller can resume the normal lifecycle.

Only resume execution when the application also knows the operation did not start elsewhere. Reconciliation proves reservation state; it cannot prove external business work was not independently started.

### `active` / `liable`

The reservation exists and metered execution may already have started. Do **not** execute the operation again. Continue only through application-specific recovery/reconciliation of the already-started work. The returned reservation can be reattached server-side when renew/settle is required, but reattachment is not permission to repeat the business side effect.

### `settled`

The original reservation already reached settlement. Do not execute the operation again.

### `expired`

The original reservation is expired or has already been conservatively converted from an expired liable lease. Reconciliation does not trigger expiry recovery or modify accounting state. Do not blindly execute the operation again.

### `absent`

No retained reservation/tombstone exists at lookup time. This does not become proof that the original reserve never committed if lookup happens after state retention/cleanup horizons. The application must make a conservative decision based on its retry/reconciliation horizon.

## Identity verification and privacy

The client recomputes the same opaque reservation ID from the original logical operation identity and SHA-256 hashes the original budget keys locally.

The lookup request sends only the opaque `cf1.<sha256>` reservation ID. It does not send raw principal IDs, tenant IDs, tool names, operation IDs, budget keys, or tool arguments.

When a retained reservation is found, the client verifies:

- the reservation ID matches the original operation;
- `reservedUnits` matches the caller's expected retained scalar units;
- the stored hashed budget identifiers exactly match the original budget set.

Raw request and budget values are used only on the caller side to reconstruct `ReservationRecord`.

Hashing is not encryption. Identifiers should remain non-secret.

## Concurrency and quota safety

Lookup is a single read-only Durable Object SQLite query. Concurrent reconciliation calls cannot reserve another unit or release the existing reservation.

The normal state machine remains authoritative:

```text
reserve -> pending -> liable -> settled
```

Only normal `reserve`, `markLiable`, `renew`, `settle`, and expiry recovery operations change accounting state.

## Transport behavior

Reconciliation uses the same bounded remote-transport semantics as `RemoteCloudflareUsageStore`: one `timeoutMs` deadline covers asynchronous header resolution, HTTP fetch, response-body decoding, and protocol validation. No state-changing call is automatically retried.

`CloudflareUsageTransportError` retains only bounded transport diagnostics. When an HTTP response exists, `status` is preserved for unauthorized/remote/protocol failures; arbitrary remote response bodies, credentials, and request identity values are never copied into the error.

## Operational guidance

- reconcile only after an ambiguous reserve transport failure;
- use the exact original request identity, units, and budgets;
- do not automatically retry reserve before reconciliation;
- distinguish `duplicate_operation` from transport ambiguity;
- reconcile promptly, within the application's idempotency/retry horizon;
- treat reconciliation transport/protocol failures as fail-closed;
- never convert an unknown reconciliation state into unmetered execution.

The local workerd integration suite simulates a committed reserve followed by a lost acknowledgement, performs concurrent read-only reconciliation, verifies that the original quota remains reserved, reattaches the recovered reservation through `UsageControl.resumeLease()`, settles it, and verifies capacity recovery.
