# Cloudflare historical budget pruning

Windowed usage policies commonly put the application window in the budget key, for example `tenant:user:daily:2026-08-11`. Old windows therefore leave historical `budgets` rows in Durable Object SQLite.

`mcp-usage-control-cloudflare` does **not** infer which windows are obsolete. The application/operator owns retention policy. The optional maintenance API only deletes exact budget keys that the caller explicitly selects as historical.

## Safety model

Historical pruning is deliberately separate from normal usage enforcement.

- each invocation accepts at most 64 historical candidates;
- each invocation also accepts at most 64 explicitly protected/current keys;
- raw budget keys are SHA-256 hashed before crossing the Cloudflare HTTP boundary;
- a protected/current key is never deleted by that invocation;
- a key referenced by any `pending` or `liable` reservation is never deleted;
- an expired active row that has not yet gone through normal recovery is still treated conservatively as active and blocks pruning;
- settled/tombstoned reservations do not block pruning because settlement replay no longer updates budget balances;
- pruning does not change reservation, settlement, replay, or expiry-recovery state;
- maintenance endpoint failure is fail-closed.

The API can intentionally delete a historical budget row whose `used` value is positive. That is the purpose of the maintenance operation: the application has declared that exact accounting window no longer participates in current enforcement.

## Separate maintenance gateway

Use a dedicated maintenance route and preferably a credential/policy distinct from the normal MCP usage gateway:

```ts
import { createCloudflareBudgetMaintenanceGateway } from 'mcp-usage-control-cloudflare/maintenance';

const maintenanceHandler = createCloudflareBudgetMaintenanceGateway({
  namespace: env.USAGE_CONTROL,
  domainName: 'production',
  authorizeMaintenance: request =>
    request.headers.get('authorization') === `Bearer ${env.USAGE_MAINTENANCE_TOKEN}`,
});
```

The default path is `/v1/usage-store-maintenance`. Do not expose this route with an allow-all policy.

A Worker can route normal usage requests to `createCloudflareUsageStoreGateway()` / `createReconciliableCloudflareUsageStoreGateway()` and only the maintenance path to `createCloudflareBudgetMaintenanceGateway()`.

## Client usage

Pass exact historical candidates and the current/retained keys that must remain protected:

```ts
import { pruneRemoteCloudflareHistoricalBudgets } from 'mcp-usage-control-cloudflare/maintenance';

const result = await pruneRemoteCloudflareHistoricalBudgets(
  {
    endpoint: process.env.MCP_USAGE_CLOUDFLARE_MAINTENANCE_URL!,
    headers: () => ({
      authorization: `Bearer ${process.env.MCP_USAGE_CLOUDFLARE_MAINTENANCE_TOKEN!}`,
    }),
  },
  {
    historicalBudgetKeys: oldWindowKeys,
    protectedCurrentBudgetKeys: currentWindowKeys,
  },
);
```

The result classifies every requested historical candidate as exactly one of:

- `prunedKeys` — row deleted;
- `blockedProtectedKeys` — also listed as protected/current;
- `blockedActiveKeys` — referenced by a pending/liable reservation;
- `missingKeys` — no budget row existed.

A malformed or incomplete maintenance reply is rejected rather than guessed.

## Choosing historical keys

Retention semantics remain application-owned. A safe operating procedure is:

1. derive completed accounting windows from the same application logic that constructs budget keys;
2. keep all current windows and any policy-required reconciliation/audit horizon in `protectedCurrentBudgetKeys`;
3. prune only exact windows older than that application-defined horizon;
4. submit candidates in batches of at most 64;
5. retry only the keys still intentionally historical; active-blocked keys can be reconsidered after their reservations settle/recover;
6. monitor maintenance failures independently from business `quota_exceeded` results.

Do not generate candidate keys by guessing hashes or by scanning arbitrary Durable Object state from application code.

## Active and expired reservations

Maintenance intentionally does not run reservation recovery. If a budget is still referenced by a `pending` or `liable` row, pruning blocks it even when its lease timestamp has passed.

This keeps maintenance from changing normal conservative recovery semantics. Let the normal usage-control path perform expiry recovery first, then retry that exact historical candidate later if the application still considers it obsolete.

## Replay and idempotency

Deleting an old budget row does not delete reservation tombstones. A retained settled reservation therefore keeps its existing settlement replay behavior.

After the normal tombstone/idempotency retention horizon has passed, an old logical operation may no longer be protected by its reservation tombstone. Applications must not reuse old window keys or operation IDs merely because a historical budget row was pruned.

## Bounded work

The hard 64-candidate limit makes pruning incremental. Each candidate performs bounded point lookup/delete work plus an active-reservation reference check inside one Durable Object transaction. Large retention sweeps should be split into multiple operator/application-controlled invocations rather than one unbounded maintenance request.
