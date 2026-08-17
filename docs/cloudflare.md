# Cloudflare Durable Objects adapter — v0.1

[English](cloudflare.md) | [日本語](cloudflare.ja.md)

`mcp-usage-control-cloudflare` implements the core `UsageStore` contract with a SQLite-backed Cloudflare Durable Object.

> **Current distribution status:** the package is not published to npm yet. Use [source / local tarballs](using-from-source.md).

## Why Durable Objects

Usage admission is a read-modify-write transaction: every participating budget must admit or none may change. The adapter therefore uses one Durable Object as one atomic transaction domain and performs the state transition in synchronous SQLite transactions.

Workers KV is not used for the accounting path.

## Components

The package exposes:

- `CloudflareUsageStore` — Worker-local `UsageStore` using a Durable Object namespace binding.
- `RemoteCloudflareUsageStore` — HTTP client for applications outside Cloudflare.
- `createCloudflareUsageStoreGateway()` — authenticated Worker handler for the remote client.
- `mcp-usage-control-cloudflare/worker` → `UsageControlDurableObject` — SQLite Durable Object implementation.

Core remains Cloudflare-independent.

## Transaction domain

One configured `domainName` maps to one Durable Object instance. Every budget in one reservation is checked and updated inside that same object.

This deliberately mirrors the Redis adapter's single transaction-domain rule. It prioritizes correctness over horizontal write distribution. A very hot global domain can become a scalability bottleneck; applications may partition independent usage domains only when no atomic reservation spans those partitions.

## Worker-local setup

Export the Durable Object class from your Worker entry point:

```ts
export { UsageControlDurableObject } from 'mcp-usage-control-cloudflare/worker';
```

Then create the store from the namespace binding:

```ts
import { CloudflareUsageStore } from 'mcp-usage-control-cloudflare';

const store = new CloudflareUsageStore(env.USAGE_CONTROL, {
  domainName: 'production',
});
```

A current Wrangler configuration can bind the class to SQLite-backed Durable Object storage. Keep the class and binding names consistent with your Worker export/configuration.

## External / GCP setup

Durable Object namespace bindings are Worker-local. For a GCP-hosted MCP server, deploy a small Worker gateway and use `RemoteCloudflareUsageStore` from the application.

Worker side:

```ts
import { createCloudflareUsageStoreGateway } from 'mcp-usage-control-cloudflare';

const usageHandler = createCloudflareUsageStoreGateway({
  namespace: env.USAGE_CONTROL,
  domainName: 'monokura-dogfood',
  authorize: request => {
    return request.headers.get('authorization') === `Bearer ${env.USAGE_GATEWAY_TOKEN}`;
  },
});
```

Application side:

```ts
import { RemoteCloudflareUsageStore } from 'mcp-usage-control-cloudflare';

const store = new RemoteCloudflareUsageStore({
  endpoint: process.env.MCP_USAGE_CLOUDFLARE_URL!,
  headers: () => ({
    authorization: `Bearer ${process.env.MCP_USAGE_CLOUDFLARE_TOKEN!}`,
  }),
});
```

The simple bearer-token example demonstrates the interface only. Production authentication can be Cloudflare Access service tokens or another application-controlled mechanism. Keep credentials out of source control and telemetry.

The gateway intentionally has no unauthenticated default. An `authorize(request)` callback is required.

## Remote acknowledgement ambiguity

The remote client performs one HTTP request per store operation and does **not** automatically retry timeout/network failures.

A timeout can mean either:

- the Durable Object never applied the write; or
- the write committed and only the response was lost.

For reserve, retrying the same logical operation later is protected by the normal `(tenantId, principal.id, tool, operationId)` identity and can return `duplicate_operation` if the first write committed.

For settlement, identical replay is idempotent while its tombstone is retained. Conflicting settlement replay is rejected.

Do not hide ambiguous failures behind generic automatic retry middleware.

## Privacy boundary

The Cloudflare backend receives only the accounting data necessary to enforce state transitions:

- SHA-256 hash of the logical operation tuple;
- SHA-256 hashes of budget keys;
- quoted/actual unit counts and budget limits;
- TTL/retention durations;
- SHA-256 hash of the settlement outcome;
- opaque reservation state.

It does not receive raw principal IDs, tenant IDs, tool names, operation IDs, budget keys, or tool arguments from this adapter.

Hashing is not encryption. Identifiers should still be non-secret and should not embed tokens, credentials, or sensitive payloads.

## Lifecycle

The backend preserves the core lifecycle:

```text
pending -> liable -> settled
```

- `reserve`: all budgets reserve atomically or none does.
- `markLiable`: records entry into the metered execution boundary.
- `renew`: extends an active pending/liable lease.
- `settle`: releases unused units from every participating budget and creates a bounded replay tombstone.
- pending expiry: releases the whole reservation.
- liable expiry: conservatively retains the full reservation and creates a tombstone.

Explicit settlement while still pending remains allowed so an application can settle zero before metered work starts when it can prove no usage was incurred.

## Cleanup and cost behavior

The adapter intentionally does not schedule Durable Object alarms for routine reservation/tombstone cleanup. Expired state is recovered lazily and in a bounded batch during later admissions; directly touched expired reservations are recovered immediately.

Advantages:

- no periodic background request solely for cleanup;
- no alarm write for every lease renewal;
- an idle usage domain can remain idle.

Trade-off:

- a large expired backlog may delay pending-capacity recovery until enough subsequent admissions perform cleanup;
- stale settled tombstones can remain physically present longer than their logical retention until cleanup runs.

This is conservative for quota enforcement but should be monitored for high-crash/high-abandonment workloads.

## Budget-window retention

Like the Redis adapter, the Cloudflare adapter does not infer daily/monthly reset semantics. Put the window in the budget key.

The backend hashes that key before storage. Positive historical budget rows are not automatically deleted because a generic adapter cannot know when an application's accounting window is safe to discard.

Long-running deployments should define retention/reconciliation appropriate to their own window lifecycle before accumulated historical budget rows become material.

## Observability

Use the same observer on `UsageControl` and the Cloudflare store when both runtime lifecycle and backend recovery events are needed.

Cloudflare recovery events use `store: 'cloudflare'` and can report:

- aggregate pending-release count/units from lazy cleanup;
- aggregate liable-retained count/units;
- an opaque hashed reservation ID when a directly addressed expired reservation is recovered.

Observer failures remain outside the enforcement result. Do not use unique reservation/operation/principal identifiers as metric labels.

See [Observability](observability.md).

## Local verification

The repository has a dedicated Cloudflare integration workflow. It builds the package, starts Wrangler in local mode (workerd), and exercises the real Worker gateway + SQLite Durable Object path.

Coverage includes:

- 100-way contention for one remaining unit;
- duplicate operation blocking;
- settlement replay/conflict;
- pending and liable expiry;
- lease renewal for long-running work;
- lost reserve acknowledgement behavior;
- lost settlement acknowledgement reconciliation;
- gateway authentication;
- observer failure isolation.

## Current limitations

- every budget in one reservation uses the same quoted/actual unit count, matching core v0.1;
- one Durable Object instance serializes one configured transaction domain;
- cleanup is lazy/bounded;
- historical used-budget row retention is application-specific;
- remote gateway authentication/credential rotation is application responsibility;
- this enforcement state is not a financial-grade accounting ledger;
- MCP multi-round `input_required` remains outside v0.1 `protectTool()` support.

## Atomic heterogeneous vector usage (v0.7 / schema v3)

`CloudflareUsageStore` and `RemoteCloudflareUsageStore` implement optional `VectorUsageStore`. The base `reservations` row remains the shared operation/lifecycle identity, while schema v3 stores vector-only metadata in the additive `reservation_vectors` sidecar table. Existing v1/v2 scalar accounting rows are not rewritten.

Durable Object `transactionSync` covers all vector dimension/budget changes plus reservation/vector metadata. Vector HTTP methods are additive protocol-v1 methods (`reserve_vector`, `grow_vector`, `settle_vector`); existing scalar callers remain compatible. Local workerd CI runs portable vector conformance and remote committed-vector-growth acknowledgement-loss replay.
