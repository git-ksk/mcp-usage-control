# MCP integration

[English](mcp-integration.md) | [日本語](mcp-integration.ja.md)

`@mcp-usage-control/mcp` adapts the core usage-control lifecycle to tool handlers from `@modelcontextprotocol/server` v2.

The adapter does not authenticate users and does not decide subscription entitlements. It expects the application to derive a trusted `Principal` and a stable idempotency `operationId`.

## Where the wrapper sits

With the MCP TypeScript SDK v2, a tool is registered with `registerTool(name, config, handler)`. `protectTool()` wraps the handler:

```ts
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { protectTool } from '@mcp-usage-control/mcp';

const server = new McpServer({ name: 'example', version: '1.0.0' });

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
      principal: async ctx => getPrincipalFromTrustedAuthContext(ctx),
      operationId: async (args, ctx) => getStableInvocationId(args, ctx),
    },
    async ({ query }) => {
      return {
        content: [{ type: 'text', text: await searchCatalog(query) }],
      };
    },
  ),
);
```

The SDK still performs its normal argument validation. Usage admission happens when the wrapped handler is invoked.

## Principal derivation

A principal is an accounting identity, not an authentication mechanism:

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

Derive it from authentication state that your server already trusts. Do not accept a caller-supplied `principal.id`, plan, or tenant identifier without authorization checks.

The core currently scopes duplicate operation IDs to `principal.id`. If your application uses shared tenant budgets, ensure your policy and future multi-budget design preserve the intended tenant isolation.

## Operation IDs

`operationId` is the idempotency key for one logical tool execution.

A good operation ID is:

- stable across transport/client retries of the same logical invocation;
- different for two intentional invocations with identical arguments;
- derived from trusted request/dispatch state rather than model-provided arguments alone;
- non-secret.

Do not generate a fresh random ID every time a retry reaches the handler; doing so defeats duplicate-operation protection. Do not treat the operation ID as authentication or authorization data.

## Lease heartbeat

By default, `protectTool()` renews an active reservation at approximately one third of its lease TTL while the handler is running. Before settlement it stops the heartbeat and waits for any in-flight renewal to finish, preventing an ordinary renew/settle race.

```ts
protectTool(
  {
    control,
    tool: 'long_job',
    principal,
    operationId,
    leaseHeartbeat: true,
  },
  handler,
);
```

Set `leaseHeartbeat: false` only when the application provides an equivalent renewal/fencing mechanism.

### Important distributed-lease limitation

The built-in heartbeat is a convenience mechanism, not provider-specific fencing. Individual renewal errors are not used to cancel an arbitrary upstream operation. A sufficiently long Redis/network partition can therefore outlive a lease while the upstream tool keeps running.

If losing lease ownership must immediately stop or fence the metered resource, implement that behavior in the application/provider adapter. See [Architecture](architecture.md).

## Success settlement

Without `successUnits`, a successful handler settles the full reserved amount. For dynamic-cost tools, reserve a safe maximum in policy and return the actual amount after execution:

```ts
protectTool(
  {
    control,
    tool: 'generate_report',
    principal,
    operationId,
    successUnits: ({ result }) => result.usageUnits,
  },
  handler,
);
```

The current contract requires `actualUnits <= reservedUnits`.

## Error settlement

Unhandled tool errors are conservative by default: the full reservation is charged. This avoids a quota-bypass pattern where a caller deliberately triggers a failure after upstream cost was already incurred.

Return a lower `errorUnits` value only when the application can prove the metered resource was not consumed or knows the exact partial cost:

```ts
errorUnits: ({ error, lease }) => {
  if (error instanceof ValidationBeforeUpstreamError) return 0;
  return lease.reservedUnits;
}
```

Avoid classifying broad network errors as zero-cost unless you can prove the upstream operation did not happen.

## Settlement failures

A settlement error is surfaced as `UsageSettlementError`. The adapter does not blindly retry settlement because a datastore can apply a write and lose only the acknowledgement.

```ts
try {
  await protectedHandler(args, ctx);
} catch (error) {
  if (error instanceof UsageSettlementError) {
    // The datastore state may be ambiguous. Preserve the operation ID and
    // reconcile/retry only through an idempotent recovery path.
  }
  throw error;
}
```

The Redis adapter is designed so replaying an identical settlement is idempotent, but recovery policy remains an application concern.

## Denials

When admission is denied, the adapter throws `UsageDeniedError` before executing the wrapped handler. Map that error to the MCP result/error behavior appropriate for your server and client UX.

Do not expose unrelated tenant balances or internal budget identifiers in user-facing messages unless that disclosure is intentional.

## MCP SDK compatibility

The adapter targets the public `@modelcontextprotocol/server` v2 API and uses the public `ServerContext` type. The core package does not import the MCP SDK, which keeps protocol/SDK churn isolated to this adapter.

The repository currently verifies its TypeScript build against `@modelcontextprotocol/server` v2.0.0. Before upgrading the peer dependency, run the full CI suite and review SDK migration notes.