# MCP integration

[English](mcp-integration.md) | [日本語](mcp-integration.ja.md)

`@mcp-usage-control/mcp` adapts the core usage-control lifecycle to **single-round** tool handlers from `@modelcontextprotocol/server` v2.

The adapter does not authenticate users and does not decide subscription entitlements. It expects the application to derive a trusted `Principal` and a stable idempotency `operationId`.

## Where the wrapper sits

With the MCP TypeScript SDK v2, a tool is registered with `registerTool(name, config, handler)`. `protectTool()` wraps the handler:

```ts
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
    async ({ query }) => ({
      content: [{ type: 'text', text: await searchCatalog(query) }],
    }),
  ),
);
```

The SDK still performs its normal argument validation before the wrapped handler runs.

## Execution lifecycle

For an admitted call, the wrapper performs:

```text
reserve -> markLiable -> start heartbeat -> handler -> stop heartbeat -> classify -> settle
```

`markLiable()` happens immediately before handler entry. From that point onward, lease expiry is conservative: if the process disappears before settlement, the full reservation remains charged instead of being reclaimed as unused.

This is intentionally conservative because the generic wrapper cannot know exactly where a provider-specific API/compute cost begins. If you need a later cost-liability boundary, use the core lifecycle directly or build a provider-specific adapter.

## Principal derivation

A principal is an accounting identity, not an authentication mechanism:

```ts
interface Principal {
  id: string;
  tenantId?: string;
  plan?: string;
}
```

Derive it from authentication state that your server already trusts. Do not accept caller-supplied principal, plan, or tenant identifiers without authorization checks.

## Operation IDs

`operationId` is the idempotency key for one logical invocation. It should be stable across retries of the same logical execution, different for intentional new executions, non-secret, and derived from trusted request/dispatch state.

The MCP JSON-RPC request ID (`ctx.mcpReq.id`) is useful for tests and some request-scoped cases, but do not assume it is a stable logical idempotency key across host/client retries. Applications that need retry-stable accounting must provide their own stable invocation identity.

## Lease heartbeat

By default, `protectTool()` renews an active reservation at approximately one third of its lease TTL while the handler runs. Before settlement it stops the heartbeat and waits for any in-flight renewal to finish.

A renewal failure does not prove that the lease was lost, so the generic wrapper does not automatically cancel arbitrary upstream work. Because execution-started leases are cost-liable, an actual expiry charges conservatively rather than refunding the call. If losing lease ownership must immediately stop work, implement provider-specific fencing/cancellation.

## Successful results

Without `successUnits`, a normal successful result settles the full reservation. For dynamic-cost tools, reserve a safe maximum in policy and return the actual units after execution:

```ts
successUnits: ({ result }) => result.usageUnits
```

The current contract requires `actualUnits <= reservedUnits`.

If `successUnits` throws or returns a negative, unsafe, or over-reservation value, the wrapper **does not leave the lease pending**. It settles the full reservation and then surfaces `UsageClassificationError`.

## MCP tool errors (`isError: true`)

MCP tool handlers may return an ordinary result with `isError: true`. This is not treated as success.

Use `toolErrorUnits` when a tool-error result has a known cost:

```ts
toolErrorUnits: ({ result, lease }) => {
  if (isKnownZeroCostMiss(result)) return 0;
  return lease.reservedUnits;
}
```

Without `toolErrorUnits`, the full reservation is charged. If the classifier fails, the full reservation is settled before `UsageClassificationError` is surfaced.

## Thrown errors

Unhandled thrown errors are also conservative by default: the full reservation is charged. Return a lower `errorUnits` value only when the application can prove the metered resource was not consumed or knows the exact partial cost.

```ts
errorUnits: ({ error, lease }) => {
  if (error instanceof ValidationBeforeUpstreamError) return 0;
  return lease.reservedUnits;
}
```

Avoid classifying broad network errors as zero-cost unless you can prove the upstream operation did not happen.

## `input_required` is not yet supported

MCP v2 can return `resultType: 'input_required'`, collect input at the client, and invoke the tool handler again in a fresh request. Correct quota accounting for that flow needs reservation suspend/resume semantics across rounds.

The current pre-alpha `protectTool()` therefore intentionally rejects `input_required`. If a wrapped handler returns it, the current reservation is conservatively settled and `UnsupportedMcpUsageFlowError` is surfaced. This is preferable to silently charging every round or deadlocking on a reused operation ID.

Do **not** wrap a production multi-round `input_required` tool with `protectTool()` until explicit support lands. This limitation is tracked for v0.1.

## Settlement failures

A settlement error is surfaced as `UsageSettlementError`. The adapter does not blindly retry settlement because a datastore can apply a write and lose only the acknowledgement.

The Redis adapter makes an identical settlement replay idempotent, but recovery/reconciliation policy remains an application concern.

## Denials and information disclosure

Admission denial throws `UsageDeniedError`. Its human-readable message is intentionally generic: `Usage denied by usage policy`. The detailed `reason` remains available as a programmatic property but is not interpolated into the thrown message.

Treat policy reasons as internal unless you intentionally map them to a safe MCP result. Do not expose tenant identifiers, internal budget keys, balances, or entitlement internals merely because they are present in a denial reason.

## Protocol integration tests

The repository tests the wrapper directly and also through the official SDK v2 `Client + createMcpHandler` in-process path. The protocol tests pin:

- `isError: true` preservation and tool-error accounting;
- generic denial messages without internal reason disclosure;
- explicit rejection of unsupported `input_required` flows.

## MCP SDK compatibility

The adapter targets the public `@modelcontextprotocol/server` v2 API and currently builds/tests against v2.0.0. The core package does not import the MCP SDK, which keeps protocol/SDK churn isolated to this adapter.