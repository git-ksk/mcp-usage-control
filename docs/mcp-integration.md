# MCP integration — v0.1

[English](mcp-integration.md) | [日本語](mcp-integration.ja.md)

`mcp-usage-control-mcp` adapts the core lifecycle to **single-round** tool handlers from `@modelcontextprotocol/server` v2.

> **Current distribution status:** the adapter is not published to npm yet. Build/install the local core + MCP tarballs as described in [Use from source / local tarballs](using-from-source.md), together with `@modelcontextprotocol/server@2.0.0`.

The adapter does not authenticate callers or decide subscriptions. The application must derive a trusted `Principal` and a suitable logical `operationId`.

## Register a protected tool

```ts
import { protectTool } from 'mcp-usage-control-mcp';

server.registerTool(
  'search',
  {
    description: 'Search the catalog',
    inputSchema: z.object({ query: z.string() }),
  },
  protectTool(
    {
      control,
      tool: 'search',
      principal: ctx => getPrincipalFromTrustedAuthContext(ctx),
      operationId: (args, ctx) => getStableInvocationId(args, ctx),
    },
    async ({ query }) => ({
      content: [{ type: 'text', text: await searchCatalog(query) }],
    }),
  ),
);
```

The MCP SDK still performs its normal argument validation before the wrapped application handler runs.

## Tools without an input schema

Set `noInput: true` explicitly:

```ts
server.registerTool(
  'ping-backend',
  { description: 'Check backend health' },
  protectTool(
    {
      control,
      tool: 'ping-backend',
      noInput: true,
      principal: ctx => getPrincipalFromTrustedAuthContext(ctx),
      operationId: (_args, ctx) => getStableInvocationId(undefined, ctx),
    },
    async (_args, ctx) => ({
      content: [{ type: 'text', text: await pingBackend(ctx) }],
    }),
  ),
);
```

This flag is intentionally explicit. The SDK public TypeScript callback model represents no-input tools as `(ctx)`, while server dispatch can be observed as `({}, ctx)`. `{}` can also be valid input for an empty object schema, so runtime guessing would be unsafe. In `noInput: true` mode the adapter normalizes the no-input path to `args === undefined` and the real `ServerContext`.

## Execution lifecycle

For an admitted call:

```text
reserve -> markLiable -> heartbeat -> handler -> stop heartbeat -> classify -> settle
```

The liability boundary is immediately before application handler entry. The generic adapter cannot know a provider-specific point where cost actually begins, so it chooses a conservative boundary. Use the core lifecycle directly if the application needs a later, provider-aware `markLiable()` point.

## Observability

The MCP adapter does not define a second telemetry system. Configure a provider-neutral `UsageObserver` on the `UsageControl` used by `protectTool()`; reserve/denial/settlement/error events then follow the same lifecycle as direct core calls. If the store is Redis, pass the same observer to `RedisUsageStore` to include expiry-recovery events.

Tool arguments are not copied into usage events automatically. See [Observability](observability.md) for privacy, cardinality, metadata, and delivery semantics.

## Principal trust

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

Derive principal, tenant, and plan from server-side context your application already trusts. Do not accept caller-provided accounting identity without authorization checks.

## Operation IDs and replay scope

Core replay protection is scoped to:

```text
(tenantId, principal.id, tool, operationId)
```

`operationId` should be stable across retries of the same logical execution and different for intentional new executions. It is non-secret idempotency identity, not authorization proof.

`ctx.mcpReq.id` is useful for request-scoped cases and tests, but applications should not assume a client/host will preserve the same JSON-RPC request ID across logical retries. Provide your own stable invocation identity when retry-stable accounting matters.

## Lease heartbeat

`protectTool()` renews the active lease at roughly one third of its TTL by default. Before settlement it stops the heartbeat and waits for an in-flight renewal.

A renewal error does not prove whether Redis applied the renewal. The adapter therefore does not cancel arbitrary upstream work automatically. If lease loss must immediately fence upstream work, implement provider-specific fencing/cancellation.

## Result and cost classification

### Normal success

Without `successUnits`, the full reservation is charged. For dynamic cost, reserve a safe maximum and report actual units:

```ts
successUnits: ({ result }) => result.usageUnits
```

### MCP tool error (`isError: true`)

An explicit `{ isError: true }` result is classified as a tool error rather than success. Use `toolErrorUnits` only when the actual cost is known.

### Thrown error

Thrown errors charge the full reservation by default. Return a lower `errorUnits` value only when the application can prove a lower incurred cost.

```ts
errorUnits: ({ error, lease }) => {
  if (error instanceof ValidationBeforeUpstreamError) return 0;
  return lease.reservedUnits;
}
```

### Classifier failure

A classifier that throws or returns a negative/unsafe/over-reservation value does not leave usage unsettled. The wrapper settles the full reservation first, then throws `UsageClassificationError`.

## `input_required` support boundary

MCP v2 `resultType: 'input_required'` is a multi-round flow: the client collects input and a fresh request re-enters tool execution. Correct accounting requires reservation suspend/resume, abandonment recovery, cross-round replay identity, and trust rules for carried state.

**v0.1 does not support this flow in `protectTool()`.** If a wrapped handler returns `input_required`, the current reservation is conservatively settled and `UnsupportedMcpUsageFlowError` is surfaced. Do not wrap production `input_required` tools until issue #14 is implemented.

## Settlement failures

A settlement failure surfaces as `UsageSettlementError`. The wrapper does not blindly retry because the store may have committed the write while only the acknowledgement was lost.

`mcp-usage-control-redis` makes an identical settlement replay idempotent and rejects conflicting settlement replay. Application-level reconciliation remains separate.

## Denials and disclosure

Admission denial throws `UsageDeniedError`. Its error message is intentionally generic (`Usage denied by usage policy`). Detailed `.reason` remains programmatic.

Do not place secrets, private tenant identifiers, entitlement internals, or balances into denial reasons that might later be mapped to user/model-visible content.

## Protocol integration tests

CI tests the wrapper directly and through the official SDK v2 `Client + createMcpHandler` in-process path, including:

- explicit no-input normalization;
- validated input-schema `(args, ctx)` behavior;
- `isError: true` accounting;
- generic denial messages;
- explicit unsupported `input_required` behavior.

The adapter targets the public `@modelcontextprotocol/server` v2 API and v0.1 CI currently resolves v2.0.0. Core does not import the MCP SDK.
