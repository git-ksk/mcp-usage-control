# Getting started

[English](getting-started.md) | [日本語](getting-started.ja.md)

## Requirements

- Node.js 20 or later
- Redis 7 when using `mcp-usage-control-redis`
- MCP TypeScript SDK v2 when using `mcp-usage-control-mcp`

## Current installation path

The packages are **not published to npm yet**. For current use, clone the repository and either work directly from the checkout or pack local `.tgz` packages for installation into another project.

Verify the repository:

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

To consume the packages from another application now, follow **[Use from source / local tarballs](using-from-source.md)**. That guide uses the same package artifacts that CI installs into a clean consumer project.

After the first npm registry publish completes, this section will switch to registry installation as the primary path. Source/tarball installation will remain supported for development and unreleased commits.

CI runs the frozen dependency graph on Node.js 20/22 with real Redis 7 and the official MCP SDK v2 client/handler integration path.

## Mental model

```text
principal -> policy -> quote -> atomic reserve -> mark liable -> execute -> settle
                                 ^                          |
                                 |----------- renew --------|
```

The policy decides whether the invocation is eligible, how many units it may consume, and which budgets apply. The store compares and reserves every participating budget atomically.

A reservation is initially `pending`. Immediately before metered execution begins, call `markLiable()`. Pending expiry releases capacity. Cost-liable expiry retains the full reservation so a worker/process crash after execution starts cannot become a refund.

## Define a policy

```ts
import { MemoryUsageStore, UsageControl, type UsagePolicy } from 'mcp-usage-control';

const policy: UsagePolicy = {
  quote(request) {
    const tenantId = request.principal.tenantId ?? 'personal';
    return {
      decision: 'allow',
      units: request.tool === 'full_export' ? 5 : 1,
      budgets: [
        { key: `day:user:${request.principal.id}:2026-08-10`, limit: 20 },
        { key: `month:user:${request.principal.id}:2026-08`, limit: 100 },
        { key: `month:tenant:${tenantId}:2026-08`, limit: 2_000 },
      ],
    };
  },
};

const control = new UsageControl(new MemoryUsageStore(), policy);
```

All listed budgets reserve or none does. Budget keys are application-defined. For calendar windows, use explicit window-qualified keys; the runtime does not guess reset dates.

A single-budget policy may use `budget` instead of `budgets`.

## Reserve and settle directly

```ts
const admission = await control.reserve({
  operationId: 'logical-request-123',
  principal: { id: 'user-42', tenantId: 'org-7', plan: 'free' },
  tool: 'search',
  args: { query: 'example' },
});

if (!admission.allowed) {
  // quota_exceeded can include limitingBudgetKey and remaining.
  throw new Error(`usage denied: ${admission.reason}`);
}

await admission.lease.markLiable();
try {
  const result = await performMeteredWork();
  await admission.lease.settle(1, 'success');
  return result;
} catch (error) {
  await admission.lease.settle(admission.lease.reservedUnits, 'error');
  throw error;
}
```

Use zero settlement only when the application can prove that the metered resource was not consumed. The in-memory store is for tests/local development, not distributed production enforcement.

## Idempotency

Use the same `operationId` when retrying the same logical invocation. Replay protection is scoped to:

```text
(tenantId, principal.id, tool, operationId)
```

`operationId` is not a credential. Principal and tenant values must come from trusted application/authentication context.

Settled operations remain replay-protected for 24 hours by default. Configure `idempotencyTtlMs` on the Memory or Redis store if your retry horizon requires a different value.

## Production Redis store

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from 'mcp-usage-control-redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const control = new UsageControl(new RedisUsageStore(redis), policy);
```

Redis performs multi-budget admission and lifecycle changes atomically in one transaction domain. Lease and tombstone time comes from Redis server `TIME`. Review [Redis adapter](redis.md) for HA/persistence, cleanup, Redis Cluster, and acknowledgement-ambiguity details.

## MCP tool handlers

For `@modelcontextprotocol/server` v2 **single-round** tools, wrap the handler with `protectTool()`:

```ts
import { protectTool } from 'mcp-usage-control-mcp';

server.registerTool(
  'search',
  { /* schema and metadata */ },
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

If the MCP tool has no input schema, pass `noInput: true`.

`protectTool()` reserves, marks the lease cost-liable, renews it while the handler runs, classifies MCP success/tool errors/exceptions, and settles. Classifier failures charge the full reservation before the classification error is surfaced.

### Multi-round MCP tools

v0.1 intentionally rejects `resultType: 'input_required'` in `protectTool()`. Correct multi-round accounting needs a suspend/resume contract across requests. Do not wrap production `input_required` tools until issue #14 is implemented.

## Production checklist

Before putting this on an enforcement path:

- derive principal/tenant IDs from trusted server-side context;
- use stable logical operation IDs for retries;
- ensure every applicable daily/monthly/tenant budget is returned by one quote;
- choose reservation TTL/heartbeat behavior appropriate to tool duration;
- classify zero-cost failures only when cost non-incurrence can be proven;
- configure Redis persistence/HA to match acceptable accounting loss;
- treat Redis atomicity as enforcement correctness, not a durable financial ledger;
- do not use the v0.1 MCP wrapper for `input_required` flows.

See [Architecture](architecture.md), [API reference](api-reference.md), [Redis adapter](redis.md), and [Security policy](../SECURITY.md).
