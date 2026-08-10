# Cloudflare reserve acknowledgement reconciliation

`RemoteCloudflareUsageStore` intentionally does not automatically retry a failed `reserve()` request. A timeout or network failure can be ambiguous: the Durable Object may have committed the reservation even though the caller did not receive the acknowledgement.

The optional reconciliation API provides a **read-only** lookup for that case. It never creates, renews, releases, or settles quota state.

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

Keep the exact original reserve input. After an ambiguous `CloudflareUsageTransportError` such as `network` or `timeout`, explicitly reconcile it:

```ts
import { reconcileRemoteCloudflareReserve } from 'mcp-usage-control-cloudflare/reconciliation';

const result = await reconcileRemoteCloudflareReserve(
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

## Result states

### `active` / `pending`

The original reserve committed and is still active, while `markLiable` has not been recorded. The API reconstructs the original `ReservationRecord` locally so the caller can resume the normal lifecycle.

Only resume execution when the application also knows the operation did not start elsewhere. Reconciliation proves reservation state; it cannot prove external business work was not independently started.

### `active` / `liable`

The reservation exists and metered execution may already have started. Do **not** execute the operation again. Continue only through application-specific recovery/reconciliation of the already-started work.

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
- `reservedUnits` matches the original attempted reserve;
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

## Operational guidance

- reconcile only after an ambiguous reserve transport failure;
- use the exact original request identity, units, and budgets;
- do not automatically retry reserve before reconciliation;
- reconcile promptly, within the application's idempotency/retry horizon;
- treat reconciliation transport/protocol failures as fail-closed;
- never convert an unknown reconciliation state into unmetered execution.

The local workerd integration suite simulates a committed reserve followed by a lost acknowledgement, performs concurrent read-only reconciliation, verifies that the original quota remains reserved, resumes the recovered reservation, settles it, and verifies capacity recovery.
