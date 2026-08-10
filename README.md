# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**Concurrency-safe usage enforcement for MCP tool execution.**

`mcp-usage-control` is a provider-neutral runtime for enforcing entitlements and usage budgets around Model Context Protocol (MCP) tool execution. v0.1 focuses on correct admission and settlement under concurrency, retries, failures, long-running handlers, and process loss.

It is not a payment processor, MCP gateway, OAuth provider, billing dashboard, or generic rate limiter.

## Install

```console
npm install mcp-usage-control
```

Optional adapters:

```console
npm install mcp-usage-control-mcp @modelcontextprotocol/server
npm install mcp-usage-control-redis redis
```

Requirements: Node.js 20+. The repository CI tests Node.js 20 and 22, Redis 7, and the official MCP TypeScript SDK v2 client/handler path.

## Core lifecycle

```text
principal -> policy/entitlement -> quote -> atomic reserve -> mark liable -> execute -> settle
                                                ^                          |
                                                |----------- renew --------|
```

The important distinction is **settlement, not automatic rollback**. A failed tool call may already have consumed an upstream API, database, compute resource, or other metered resource.

A reservation starts `pending`. Immediately before metered execution, it becomes `cost-liable`. If a pending lease expires, its reservation can be released. If a cost-liable lease expires after execution started, the full reservation is conservatively retained so a process crash cannot become a refund.

## Packages

- **`mcp-usage-control`** — core policy, atomic admission contract, renewable leases, settlement, idempotency, and the in-memory reference store.
- **`mcp-usage-control-mcp`** — adapter for `@modelcontextprotocol/server` v2 single-round tool handlers.
- **`mcp-usage-control-redis`** — atomic Redis store using Lua and Redis server time.

All three packages are ESM and require Node.js 20+.

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

### `input_required` support boundary

v0.1 intentionally does **not** support MCP v2 multi-round `input_required` flows in `protectTool()`. A correct implementation needs reservation suspend/resume semantics across fresh requests. The adapter detects this result, settles conservatively, and raises `UnsupportedMcpUsageFlowError` instead of silently double-charging rounds or deadlocking replay protection. See issue #14 for the future design.

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

## Documentation

- [Getting started](docs/getting-started.md)
- [MCP SDK v2 integration](docs/mcp-integration.md)
- [Architecture and invariants](docs/architecture.md)
- [Redis adapter](docs/redis.md)
- [API reference](docs/api-reference.md)
- [Release policy](docs/releasing.md)
- [Documentation index](docs/README.md)

Project policies: [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Support](SUPPORT.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## Scope after v0.1

Tracked follow-up work includes provider-neutral observability hooks and real `input_required` suspend/resume accounting. Billing providers, OAuth providers, dashboards, payment protocols, and generic rate limiting remain outside the core runtime.

## License

Apache-2.0
