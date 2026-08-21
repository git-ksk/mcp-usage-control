# MCP integration — current source

[English](mcp-integration.md) | [日本語](mcp-integration.ja.md)

`mcp-usage-control-mcp` adapts the core lifecycle to `@modelcontextprotocol/server` v2 tool handlers. Use `protectTool()` for single-round tools and `protectMultiRoundTool()` for explicit MCP v2 `input_required` suspend/resume flows.

> **Current distribution status:** the adapter is not published to npm yet. Build/install the local core + MCP tarballs as described in [Use from source / local tarballs](using-from-source.md), together with `@modelcontextprotocol/server@2.0.0`.

The adapter does not authenticate callers or decide subscriptions. The application must derive a trusted `Principal` and a suitable logical `operationId`.

## Register a protected single-round tool

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

## Single-round execution lifecycle

For an admitted `protectTool()` call:

```text
reserve -> markLiable -> heartbeat -> handler -> stop heartbeat -> classify -> settle
```

The liability boundary is immediately before application handler entry. The generic adapter cannot know a provider-specific point where cost actually begins, so it chooses a conservative boundary. Use the core lifecycle directly if the application needs a later, provider-aware `markLiable()` point.

## MCP v2 `input_required` suspend/resume

MCP 2026-era `input_required` retries the same logical call as a fresh MCP request. A fresh JSON-RPC request ID must not create a second usage reservation.

Use `protectMultiRoundTool()` for this flow. The first round calls the configured `operationId()` and reserves once. Later rounds reattach to the same server-side lease; they do not call policy quote or reserve again.

### Request-state integrity

MCP `requestState` is echoed through the client and must be treated as untrusted. Configure the official SDK verification seam and give the wrapper the matching mint function:

```ts
import {
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  McpServer,
} from '@modelcontextprotocol/server';
import {
  MemoryMcpUsageFlowStore,
  protectMultiRoundTool,
  type McpUsageRequestStatePayload,
} from 'mcp-usage-control-mcp';

const stateCodec = createRequestStateCodec<McpUsageRequestStatePayload>({
  key: process.env.REQUEST_STATE_SECRET!, // >= 32 bytes; keep server-side
  ttlSeconds: 600,
});

// Keep this outside the per-request createMcpHandler factory.
// Use a durable/shared implementation when requests can hit multiple processes.
const flowStore = new MemoryMcpUsageFlowStore();

const protectedConfirm = protectMultiRoundTool(
  {
    control,
    tool: 'confirm-write',
    noInput: true,
    principal: ctx => getPrincipalFromTrustedAuthContext(ctx),
    operationId: () => createStableLogicalOperationId(),
    flowStore,
    requestState: { mint: payload => stateCodec.mint(payload) },
    suspendTtlMs: 5 * 60_000,
    maxRounds: 4,
  },
  async (_args, ctx, flow) => {
    if (flow.round === 0) {
      return inputRequired({
        inputRequests: {},
        // Optional application state. The wrapper keeps it server-side and
        // replaces the wire requestState with its own integrity-protected token.
        requestState: 'awaiting-confirmation',
      });
    }

    if (flow.applicationRequestState !== 'awaiting-confirmation') {
      throw new Error('invalid application phase');
    }

    return { content: [{ type: 'text', text: 'done' }] };
  },
);

const handler = createMcpHandler(() => {
  const server = new McpServer(
    { name: 'example', version: '1.0.0' },
    { requestState: { verify: stateCodec.verify } },
  );
  server.registerTool('confirm-write', { description: 'Confirm then write' }, protectedConfirm);
  return server;
});
```

If `ctx.mcpReq.requestState()` is a raw string rather than a verified decoded payload, the wrapper fails closed with `McpUsageResumeError`. Do not disable verification and manually trust the client-echoed string.

### Server-side flow store

The client receives only an integrity-protected opaque flow reference. The trusted record contains the resumable usage lease and remains server-side.

`McpUsageFlowStore.consume(flowId, binding)` has a security-critical contract:

1. compare the stored binding to the current trusted principal / tenant / tool / canonical argument hash;
2. if it does not match, return no record **without consuming the legitimate flow**;
3. if it matches, atomically consume and return the flow exactly once.

`MemoryMcpUsageFlowStore` implements that contract for tests and one process. It is not suitable for horizontally scaled servers because a modern `createMcpHandler` request may land on another instance. Use Redis, a transactional database, Durable Objects, or another shared store that can implement atomic compare-and-consume.

### Lifecycle and abandonment

A multi-round lifecycle is:

```text
reserve -> markLiable -> handler
  -> input_required
  -> stop heartbeat -> renew(suspendTtlMs) -> persist flow -> return signed requestState
  -> fresh request -> verify requestState -> atomic consume -> resume lease -> renew
  -> handler -> ... -> classify -> settle
```

The reservation is cost-liable before the application handler first runs. Therefore an abandoned suspended flow, or a process crash after a one-time resume token has been claimed, is conservative: lease expiry retains the full reserved charge. It never silently creates a refund for work that may already have happened.

`maxRounds` bounds repeated suspension. Exceeding it settles the full reservation and raises `McpUsageRoundsExceededError`.

### Replay semantics

A resume token is one-time. Concurrent identical resume attempts can produce only one application re-entry; later attempts fail closed with `McpUsageResumeError`. A mismatched principal/tool/argument attempt cannot consume the legitimate flow.

This prevents duplicate usage reservation and duplicate handler entry for the same resume token. It does **not** make arbitrary application side effects exactly-once, and it does not cache/replay a completed business response if the response is lost after the token has already been claimed. Keep existing business idempotency/result reconciliation for destructive or externally metered operations.

### Logical operation IDs

`operationId()` is evaluated on the initial round only. The stable logical operation ID is carried in the trusted lease state and exposed as `flow.operationId` on resumed rounds.

Do not derive multi-round accounting identity from each retry's fresh `ctx.mcpReq.id`. The MCP client is allowed to use a fresh request ID when it fulfills `input_required`.

## Observability

The MCP adapter does not define a second telemetry system. Configure a provider-neutral `UsageObserver` on the `UsageControl` used by either wrapper; reserve/denial/settlement/error events then follow the same lifecycle as direct core calls. If the store is Redis, pass the same observer to `RedisUsageStore` to include expiry-recovery events.

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

For single-round tools, `operationId` should be stable across retries of the same logical execution and different for intentional new executions. It is non-secret idempotency identity, not authorization proof.

`ctx.mcpReq.id` is useful for request-scoped cases and tests, but applications should not assume a client/host will preserve the same JSON-RPC request ID across logical retries. For `protectMultiRoundTool()`, only the first round calls the application `operationId()` callback; resumed rounds reuse the trusted original identity.

## Lease heartbeat

Both wrappers renew an actively executing lease at roughly one third of its TTL by default. Before settlement or suspension they stop the heartbeat and wait for an in-flight renewal.

A renewal error does not prove whether the backend applied the renewal. The adapter therefore does not cancel arbitrary upstream work automatically. If lease loss must immediately fence upstream work, implement provider-specific fencing/cancellation.

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

## `protectTool()` support boundary

`protectTool()` remains intentionally single-round. If its handler returns `input_required`, it conservatively settles the current reservation and raises `UnsupportedMcpUsageFlowError` rather than silently accounting the retry as a new call.

Use `protectMultiRoundTool()` only when the server has the verified request-state and server-side flow-store requirements described above.

## Settlement failures

A settlement failure surfaces as `UsageSettlementError`. The wrapper does not blindly retry because the store may have committed the write while only the acknowledgement was lost.

Store-specific identical settlement replay/reconciliation remains separate from MCP flow retry semantics.

## Denials and disclosure

Admission denial throws `UsageDeniedError`. Its error message is intentionally generic (`Usage denied by usage policy`). Detailed `.reason` remains programmatic.

Do not place secrets, private tenant identifiers, entitlement internals, or balances into denial reasons that might later be mapped to user/model-visible content.

## Protocol integration tests

CI tests the wrappers directly and through the official SDK v2 `Client + createMcpHandler` in-process path, including:

- explicit no-input normalization;
- validated input-schema `(args, ctx)` behavior;
- `isError: true` accounting;
- generic denial messages;
- explicit single-round rejection of `input_required`;
- modern protocol negotiation and a real `input_required` retry through `createRequestStateCodec` verification;
- one quote/reservation across the fresh retry request and final settlement.

The adapter targets the public `@modelcontextprotocol/server` v2 API and v0.1 CI currently resolves v2.0.0. Core does not import the MCP SDK.
