# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**Concurrency-safe transactional usage enforcement for MCP tool execution.**

`mcp-usage-control` is a provider-neutral runtime for enforcing entitlements and usage budgets around Model Context Protocol (MCP) tool execution. v0.1 focuses on correct admission and settlement under concurrency, retries, failures, long-running handlers, and process loss.

It is not a payment processor, MCP gateway, OAuth provider, billing dashboard, or generic rate limiter.

## Current distribution status

**The packages are not published to npm yet.** Until the first registry publish completes, use a repository checkout or locally packed tarballs. Do not expect registry installation of `mcp-usage-control`, `mcp-usage-control-mcp`, `mcp-usage-control-redis`, or `mcp-usage-control-cloudflare` to work yet.

Quick verification from source:

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

To use the packages from another project now, build `.tgz` packages locally and install those tarballs. See **[Use from source / local tarballs](docs/using-from-source.md)** for exact commands. CI validates the same tarballs in a clean consumer project.

Requirements: Node.js 20+. The repository CI tests Node.js 20 and 22, Redis 7, and the official MCP TypeScript SDK v2 client/handler path.

## Core lifecycle

```text
principal -> policy/entitlement -> quote -> atomic reserve -> mark liable -> execute -> settle
                                                ^                          |
                                                |----------- renew --------|
```

The important distinction is **settlement, not automatic rollback**. A failed tool call may already have consumed an upstream API, database, compute resource, or other metered resource.

A reservation starts `pending`. Immediately before metered execution, it becomes `cost-liable`. If a pending lease expires, its reservation can be released. If a cost-liable lease expires after execution started, the full reservation is conservatively retained so a process crash cannot become a refund.

## Why not a rate limiter?

A normal rate limiter primarily answers whether another request may start within a time window. That is useful, but it does not by itself provide transactional accounting for work that consumes a real metered resource.

A naive `check -> execute -> increment` flow can over-admit under concurrency. If two requests both observe one remaining unit, both may execute an upstream paid operation before either increments the counter. The budget has then paid for more work than it could safely admit.

`mcp-usage-control` reserves capacity **before** metered execution and settles afterward. It also models cost liability, renewable/resumable leases, replay protection, expiry recovery, and ambiguous settlement outcomes.

| Category | Primary concern | `mcp-usage-control` difference |
| --- | --- | --- |
| Rate limiter | requests per time window | reserves metered capacity before execution and settles actual usage afterward |
| Billing/payment provider | invoicing, payment, subscriptions | intentionally outside scope; consumes policy/entitlement decisions rather than processing money |
| Gateway policy | centralized access/routing controls | enforcement can live directly around tool execution with provider-neutral stores |
| Transactional usage enforcement | admission + liability + settlement | this project's core category |

## Packages

- **`mcp-usage-control`** — core policy, atomic admission contract, renewable/resumable leases, settlement, idempotency, provider-neutral observability hooks, and the in-memory reference store.
- **`mcp-usage-control-mcp`** — adapter for `@modelcontextprotocol/server` v2 single-round tools plus opt-in `input_required` suspend/resume accounting.
- **`mcp-usage-control-redis`** — atomic Redis store using Lua and Redis server time, with optional expiry-recovery observability.
- **`mcp-usage-control-cloudflare`** — Cloudflare Durable Objects + SQLite store with Worker-local and authenticated remote-client paths.

All four packages are ESM and require Node.js 20+.

## Multi-budget admission

One logical invocation can reserve the same unit cost against several applicable budgets atomically, for example a user daily limit plus a user monthly limit plus a tenant monthly limit:

```ts
import { MemoryUsageStore, UsageControl, type UsagePolicy } from 'mcp-usage-control';

const policy: UsagePolicy = {
  quote(request) {
    const tenant = request.principal.tenantId ?? 'personal';
    return {
      decision: 'allow',
      units: request.tool === 'full_export' ? 5 : 1,
      budgets: [
        { key: `day:user:${request.principal.id}:2026-08-10`, limit: 20 },
        { key: `month:user:${request.principal.id}:2026-08`, limit: 100 },
        { key: `month:tenant:${tenant}:2026-08`, limit: 2_000 },
      ],
    };
  },
};

const control = new UsageControl(new MemoryUsageStore(), policy);
```

Admission is **all-or-nothing**. If any participating budget cannot admit the quoted units, no budget is partially reserved.

The single `budget` form is also accepted as a convenience for one-budget policies.

## Idempotency scope

Replay protection is scoped to the tuple:

```text
(tenantId, principal.id, tool, operationId)
```

Use a stable `operationId` for retries of the same logical invocation. It is an idempotency input, not an authentication or authorization credential.

Settled operations remain replay-protected for a bounded tombstone period. `MemoryUsageStore` and `RedisUsageStore` default to 24 hours (`idempotencyTtlMs`). Pending reservations that expire before becoming cost-liable release capacity and may be retried after recovery.

## Provider-neutral observability

Attach an optional observer to receive structured lifecycle events without coupling enforcement to a telemetry or billing vendor:

```ts
import { UsageControl, type UsageObserver } from 'mcp-usage-control';

const observer: UsageObserver = {
  onEvent(event) {
    console.log(JSON.stringify(event));
  },
};

const store = new RedisUsageStore(redis, { observer });
const control = new UsageControl(store, policy, {
  observer,
  metadata: { service: 'my-mcp-server', environment: 'staging' },
});
```

Events cover admission accepted/denied, settlement completed, expiry recovery, and policy/store errors. Observer delivery is **best-effort and outside the enforcement outcome**: returned promises are not awaited and observer failures never change quota state. `onEvent()` itself is invoked inline, so keep synchronous work lightweight and offload network/durable I/O. Tool arguments and raw exception messages are not captured automatically; custom metadata is explicit opt-in.

Identical idempotent settlement replay can emit another identical `settlement.completed` event. Downstream analytics that require de-duplication should use a stable key such as `(reservationId, actualUnits, outcome)`; the event stream is not the transactional ledger.

Runtime IDs can be high-cardinality. Do not use unique principal, operation, reservation, or user-specific budget IDs as metric labels. See [Observability](docs/observability.md) for event fields, privacy guidance, Redis aggregate recovery behavior, replay guidance, and delivery guarantees.

## Billing and metering adapter boundary

External billing or metering systems may define balances, entitlements, prices, invoices, receipts, or usage events with guarantees that differ from the enforcement transaction.

Keep those integrations outside the core state machine:

```text
transactional enforcement core
        -> stable observer/event contract
        -> optional billing/telemetry adapter
```

An adapter may translate stable enforcement outcomes into an external billing or MCP metering schema. External terminology or delivery guarantees must not weaken atomic admission, reservation, `cost-liable` state, idempotency, lease/expiry recovery, or conservative handling of ambiguous settlement.

The observer/event stream is integration evidence, not a financial ledger and not a substitute for the store transaction.

## Direct core example

```ts
const admission = await control.reserve({
  operationId: 'logical-request-123',
  principal: { id: 'user-42', tenantId: 'org-7', plan: 'free' },
  tool: 'search',
  args: { query: 'example' },
});

if (!admission.allowed) {
  throw new Error(`usage denied: ${admission.reason}`);
}

await admission.lease.markLiable();
try {
  const result = await performMeteredWork();
  await admission.lease.settle(1, 'success');
  return result;
} catch (error) {
  // Charge the incurred amount. Use zero only when you can prove that no
  // metered resource was consumed.
  await admission.lease.settle(admission.lease.reservedUnits, 'error');
  throw error;
}
```

Long-running work must renew its active lease. The MCP adapter provides a heartbeat by default; direct core users must renew explicitly when needed.

## MCP SDK v2 adapter

```ts
import { protectTool } from 'mcp-usage-control-mcp';

server.registerTool(
  'search',
  { /* input schema, description, ... */ },
  protectTool(
    {
      control,
      tool: 'search',
      principal: ctx => ({ id: ctx.http.authInfo.subject }),
      operationId: (_args, ctx) => String(ctx.mcpReq.id),
    },
    async (args, ctx) => search(args, ctx),
  ),
);
```

For a tool with **no input schema**, set `noInput: true`. This is explicit because MCP SDK v2's public callback type and observed runtime dispatch shape differ for no-input tools, and an empty object can also be legitimate input for an empty schema.

`protectTool()`:

- reserves before execution;
- marks the lease cost-liable before handler entry;
- renews the lease while the handler runs by default;
- distinguishes success, MCP `{ isError: true }`, and thrown errors;
- settles classifier failures conservatively with the full reservation before surfacing the classification error;
- does not blindly retry ambiguous settlement failures.

### Multi-round `input_required`

`protectTool()` remains deliberately single-round and still rejects `input_required`. Use the opt-in `protectMultiRoundTool()` when a logical operation must span fresh MCP retry requests.

The multi-round wrapper reserves only on the first round. It keeps the usage lease server-side, replaces the wire `requestState` with an integrity-protected opaque flow reference, and reattaches to the same reservation after the MCP server's `requestState.verify` hook has decoded the retry state. A server-side `McpUsageFlowStore` must atomically compare the trusted principal/tool/args binding and consume a resume token exactly once.

`MemoryMcpUsageFlowStore` is a single-process reference implementation. Horizontally scaled servers need a shared/durable flow store with the same atomic compare-and-consume contract. Suspended leases have an explicit `suspendTtlMs`; abandoned cost-liable flows retain the full reserved charge on expiry.

A one-time resume token prevents duplicate handler re-entry for the same retry. It is not a general exactly-once side-effect or completed-result replay mechanism, so destructive/external operations should keep their existing business idempotency/result reconciliation.

See [MCP SDK v2 integration](docs/mcp-integration.md) for the official `createRequestStateCodec()` setup and the complete trust boundary.

## Redis production store

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from 'mcp-usage-control-redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const store = new RedisUsageStore(redis);
```

The v0.1 Redis store performs multi-budget reserve, `markLiable`, renew, settlement, expiry recovery, and replay protection inside one Redis Cluster transaction domain. It uses Redis server `TIME`, not application `Date.now()`, for lease/tombstone decisions.

Lua atomicity is **not** the same as persistence/failover durability. Configure Redis HA and persistence to match the loss tolerance of your enforcement system. If you need a financial-grade durable ledger, reconcile enforcement state to a separate durable system.

See [Redis adapter](docs/redis.md) before production use.

## Cloudflare Durable Objects store

`mcp-usage-control-cloudflare` provides a SQLite-backed Durable Object transaction domain. Workers can use `CloudflareUsageStore` directly; applications outside Cloudflare can use `RemoteCloudflareUsageStore` through an explicitly authenticated Worker gateway. The adapter hashes operation/budget/outcome identifiers before the Cloudflare boundary and does not send tool arguments. Remote timeout/ACK ambiguity is surfaced rather than blindly retried.

See [Cloudflare adapter](docs/cloudflare.md) for Worker configuration, privacy, cleanup/cost behavior, and GCP/external usage.

## Safety invariants

1. Quota comparison and reservation are one store operation; `check -> execute -> record` is not the model.
2. Every applicable budget reserves atomically or none does.
3. Replay protection uses `(tenantId, principal.id, tool, operationId)`.
4. Entering the metered execution boundary marks a reservation cost-liable.
5. Expired pending reservations release capacity; expired cost-liable reservations retain the full charge.
6. Long-running active leases are renewable.
7. `actualUnits` cannot exceed the reserved units in v0.1.
8. Identical settlement replay is idempotent; conflicting settlement fails.
9. MCP `isError: true` is not classified as success.
10. Cost-classification failures settle conservatively before surfacing an error.
11. Ambiguous settlement failures are surfaced and are not blindly retried.
12. Storage failures do not turn into an allow decision.
13. Redis lease/tombstone time comes from Redis, not the application clock.
14. Observability is outside the enforcement transaction; observer failure cannot convert allow/deny/settlement state.
15. Multi-round MCP retries do not reserve again; the original server-side usage lease is resumed.
16. Client-round-tripped MCP request state is never used as accounting authority without integrity verification and a server-side binding check.
17. A resume token is consumed at most once; mismatched callers cannot consume the legitimate suspended flow.

## Documentation

- [Use from source / local tarballs](docs/using-from-source.md)
- [Getting started](docs/getting-started.md)
- [MCP SDK v2 integration](docs/mcp-integration.md)
- [Observability](docs/observability.md)
- [Architecture and invariants](docs/architecture.md)
- [Redis adapter](docs/redis.md)
- [Cloudflare adapter](docs/cloudflare.md)
- [Roadmap](docs/roadmap.md)
- [API reference](docs/api-reference.md)
- [Release policy](docs/releasing.md)
- [Documentation index](docs/README.md)

Project policies: [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Support](SUPPORT.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## Scope after v0.1

The near-term order is transaction-semantic hardening first: production shared/durable multi-round flow stores and post-claim reconciliation (#41), remaining deployed Cloudflare validation (#24), and final public package-contract review before npm publication (#6).

After that, planned differentiation includes a third-party store invariant test kit, a versioned enforcement event contract, production multi-budget policy examples, and optional billing/telemetry adapters that remain outside the enforcement transaction. See the [Roadmap](docs/roadmap.md).

Billing providers, OAuth providers, dashboards, payment protocols, generic rate limiting, and external billing schemas as a replacement for the core state machine remain outside the core runtime.

## License

Apache-2.0
