# Getting started

[English](getting-started.md) | [日本語](getting-started.ja.md)

This guide answers one question: **can I safely put a monthly credit limit in front of an MCP tool without building a quota state machine myself?**

## Start with a concrete product rule

Assume your MCP product has:

```text
Free plan:  50 credits / month
Plus plan: 500 credits / month
search:      1 credit
report:     10 credits
```

You want `report` to start only when all required credits have been atomically reserved. A naive `read remaining -> run tool -> increment usage` flow can overspend under concurrency; `mcp-usage-control` turns that into `reserve -> mark liable -> execute -> settle`.

This library is a good fit if those credits represent real cost or a product promise. If all you need is a coarse requests-per-minute throttle, use a normal rate limiter instead.

## What the library owns

It owns the correctness boundary between **tool execution and usage accounting**:

```text
request
  -> policy quotes units and budgets
  -> store atomically reserves quota
  -> lease becomes cost-liable immediately before metered work
  -> tool executes
  -> actual usage settles
```

It deliberately does not own authentication, subscriptions, checkout, invoicing, or your financial ledger.

## Evaluate it before npm publication

The packages are not on npm yet. For evaluation, use the validated `v0.13.0` GitHub Release tarballs or a repository checkout. The exact clean-consumer commands are in [Use from source / local tarballs](using-from-source.md).

**Node.js 22 or later is required.**

## Three concepts to remember

- **Policy** — decides whether a call is allowed, how many units it costs, and which budgets apply.
- **Store** — atomically updates budgets and reservations. Choose Memory, Redis, Cloudflare, or Firestore.
- **Lease** — represents one reserved execution slot and exposes `markLiable()`, `renew()`, and `settle()`.

## Which package should I use?

| Package | Use it for |
| --- | --- |
| `mcp-usage-control` | Core API and Memory store. Start here |
| `mcp-usage-control-mcp` | Wrapping MCP SDK v2 tool handlers |
| `mcp-usage-control-redis` | Redis-backed high-frequency/shared quotas |
| `mcp-usage-control-cloudflare` | Cloudflare Durable Objects |
| `mcp-usage-control-firestore` | Firebase/GCP deployments using Firestore as the authoritative store |

The Memory store is the process-local reference implementation. It is suitable for tests, local development, and controlled single-process deployments that explicitly accept restart loss. Use a shared provider-backed store when enforcement state must survive restarts or be shared across instances.

## Current installation path

The packages are not published to npm yet. For now, use a repository checkout or locally packed `.tgz` files.

To verify the repository:

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm check
```

See [Use from source / local tarballs](using-from-source.md) for exact commands to install the packages into another application.

**Node.js 22 or later is required.** Supported CI and release-safety evidence cover Node.js 22 and 24. Node.js 20 is EOL and is not part of the supported or required CI contract.

## Smallest example

Start with the Memory store to understand the API:

```ts
import {
  MemoryUsageStore,
  UsageControl,
  type UsagePolicy,
} from 'mcp-usage-control';

const policy: UsagePolicy = {
  quote(request) {
    return {
      decision: 'allow',
      units: 1,
      budget: {
        key: `user:${request.principal.id}:daily:2026-08-12`,
        limit: 20,
      },
    };
  },
};

const control = new UsageControl(new MemoryUsageStore(), policy);
```

This policy means one tool call costs one unit and each user gets 20 units for that day.

Budget keys are application-defined. The runtime does not infer reset dates, so a daily limit should include its window in the key. The same key remains the same accounting bucket until application policy deliberately stops using or safely retires it.

## Several budgets can be enforced together

One call can charge a user-daily, user-monthly, and tenant-monthly budget at the same time:

```ts
const policy: UsagePolicy = {
  quote(request) {
    const tenantId = request.principal.tenantId ?? 'personal';

    return {
      decision: 'allow',
      units: 1,
      budgets: [
        { key: `day:user:${request.principal.id}:2026-08-12`, limit: 20 },
        { key: `month:user:${request.principal.id}:2026-08`, limit: 100 },
        { key: `month:tenant:${tenantId}:2026-08`, limit: 2_000 },
      ],
    };
  },
};
```

Admission is **all-or-nothing**: all three budgets reserve successfully, or none of them does.

## Use the core API directly

```ts
const admission = await control.reserve({
  operationId: 'logical-request-123',
  principal: { id: 'user-42', tenantId: 'org-7' },
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
  await admission.lease.settle(
    admission.lease.reservedUnits,
    'error',
  );
  throw error;
}
```

### What does `markLiable()` mean?

It marks the point where real cost may have started.

- A reservation that expires while still `pending` can release its reserved capacity.
- If a worker dies after `markLiable()`, the full reservation is conservatively retained.

This prevents a process crash from becoming a free refund after execution has already started.

### What does `settle()` do?

It finalizes the difference between reserved units and actual units.

Settle to `0` only when the application can determine that no metered resource was consumed.

Long-running tools may also need `renew()` to keep the lease alive. The MCP adapter handles heartbeat renewal while a protected handler is running; custom integrations that can outlive the reservation TTL must provide an equivalent authoritative renewal loop.

## Choosing a production store

| Store | Good fit | Main trade-off |
| --- | --- | --- |
| Memory | Tests, local development, controlled single-process use | Restart loss; not shared across processes |
| Redis | High frequency, shared quotas, low latency | Requires Redis HA/persistence planning |
| Cloudflare Durable Objects | Cloudflare-centric deployments | A Durable Object is the serialization point |
| Firestore | Firebase/GCP, mostly user-scoped quotas | Large shared budgets can create document contention |

Read [Firestore](firestore.md), [Redis](redis.md), or [Cloudflare](cloudflare.md) before selecting a production store.

## Wrap an MCP tool

Use `protectTool()` for a single-round MCP tool:

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

`protectTool()` handles reserve, cost-liability, heartbeat renewal, handler execution, and settlement.

Pass `noInput: true` for a tool with no input schema.

### Multi-round `input_required` tools

Use `protectMultiRoundTool()` for multi-round flows.

The first request reserves once. Later rounds reattach to the same server-side lease instead of creating a fresh reservation. Because MCP `requestState` travels through the client and is untrusted, combine the wrapper with the MCP SDK's `createRequestStateCodec()` integrity verification.

See [MCP integration](mcp-integration.md) for the complete configuration.

## Reuse the same `operationId` for retries

Replay protection is scoped to:

```text
(tenantId, principal.id, tool, operationId)
```

Use the same `operationId` when retrying the same logical operation.

`operationId` is not an authentication credential. Principal and tenant identity must come from trusted server-side authentication context.

## Production checklist

Before putting the library on an enforcement path:

- run on Node.js 22 or later;
- derive principal and tenant identity from trusted server-side context;
- use stable `operationId` values for retries;
- return every applicable daily/monthly/tenant budget in one quote;
- choose TTL and renewal behavior that fits tool duration;
- settle zero units only when cost non-incurrence is known;
- never turn a store failure into an unmetered allow;
- understand the durability and contention behavior of the selected store;
- do not treat usage enforcement state as the financial ledger itself.

## What to read next

- Start an MCP integration: [MCP integration](mcp-integration.md)
- Model Free/Plus weighted credits: [Subscription-style MCP credits](subscription-credits.md)
- Choose a store: [Redis](redis.md) / [Cloudflare](cloudflare.md) / [Firestore](firestore.md)
- Understand the design: [Architecture](architecture.md)
- Look up the public API: [API reference](api-reference.md)
- Review production security: [Security policy](../SECURITY.md)
