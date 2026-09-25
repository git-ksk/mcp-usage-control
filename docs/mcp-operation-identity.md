# MCP logical operation identity for single-round reads

[English](mcp-operation-identity.md) | [日本語](mcp-operation-identity.ja.md)

This document records the v1.1 design decision for single-round read-only MCP tools that do not already have an application-level idempotency key.

## Decision

`mcp-usage-control-mcp` does **not** add a helper that derives logical accounting identity from the MCP / JSON-RPC request ID, session ID, or another weak transport identifier.

It also does **not** add a bounded deduplication cache for read-only tools and does not emit a diagnostic that claims an `operationId` is retry-stable. The adapter cannot infer that provenance from the string returned by `operationId()`.

The canonical rule remains:

- if the application has a retry-stable logical-operation key, return that key from `operationId()`;
- if it does not, treat each received tool dispatch as a new logical operation and generate a fresh server-side ID;
- never treat `ctx.mcpReq.id` as authentication, authorization, or sufficient proof that two requests are the same logical operation.

This is deliberately conservative. Without a stronger application signal, a fresh transport request can be either a retry of an earlier user action or an intentional repeated read. The library cannot distinguish those cases without risking false deduplication.

## Why there is no request-ID helper

MCP / JSON-RPC request IDs identify transport requests, not business intent. A client may use a different request ID for a retry, and a request ID may be reused after a response is complete. Adding session ID does not turn that pair into a durable logical-operation identity and can still create both false duplicates and missed retries.

A helper scoped only to the lifetime of one received request would not solve the problem either: `protectTool()` already evaluates `operationId()` once for that dispatch. The hard case is a later fresh request whose relationship to the earlier request is unknown.

## Why there is no weak read-only dedup mode

A short deduplication window keyed by arguments, request IDs, or session/request pairs would sometimes merge two intentional reads. Read-only does not mean free to collapse: a read can still incur provider cost, consume quota, observe new state, or be intentionally repeated.

The usage layer therefore does not invent exactly-once or once-per-user-action semantics from weak identifiers.

## Canonical option A: fresh ID per dispatch

Use this when the client/product has no retry-stable logical key.

```ts
import { randomUUID } from 'node:crypto';
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
      operationId: () => randomUUID(),
    },
    async ({ query }) => ({
      content: [{ type: 'text', text: await searchCatalog(query) }],
    }),
  ),
);
```

Properties:

- every received dispatch gets a distinct accounting operation;
- intentional repeated reads are never collapsed by a weak heuristic;
- a transport/client retry that arrives as a fresh dispatch can consume quota again;
- the fresh UUID is idempotency identity only and is not authorization proof.

For an ordinary read with no stronger signal, this is the canonical conservative choice.

## Canonical option B: application-provided retry-stable key

Use this only when the product can define one logical user action across retries. For example, a client may create a new opaque action ID when the user initiates a search and reuse that same ID only when retrying that action.

```ts
const SearchInput = z.object({
  query: z.string(),
  usageOperationId: z.string().min(1).max(128),
});

server.registerTool(
  'search',
  {
    description: 'Search the catalog',
    inputSchema: SearchInput,
  },
  protectTool(
    {
      control,
      tool: 'search',
      principal: ctx => getPrincipalFromTrustedAuthContext(ctx),
      operationId: args => validateApplicationOperationId(args.usageOperationId),
    },
    async ({ query }) => ({
      content: [{ type: 'text', text: await searchCatalog(query) }],
    }),
  ),
);
```

The application must define the key's lifecycle:

- create a new key for each intentional new user action;
- reuse it only for retries of that same logical action;
- validate and bound the value before use;
- do not derive authorization or tenant identity from it;
- do not combine unrelated users through a shared weak key.

Core replay scope remains:

```text
(tenantId, principal.id, tool, operationId)
```

So principal/tool isolation still applies, but that does not make an untrusted client token an authentication credential.

## What retry-stable accounting does and does not do

A stable `operationId` prevents a retry from creating a second independent usage reservation while replay state is retained. It does **not** cache or replay the business result.

If the first execution completed but its response was lost, a later request with the same logical operation ID can be rejected as a duplicate rather than re-running the handler. Applications that need successful response recovery must keep a separate business-result/idempotency layer.

## Transport request identity vs. logical operation identity

| Identity | Meaning | Safe accounting use |
| --- | --- | --- |
| `ctx.mcpReq.id` | One MCP / JSON-RPC transport request | Diagnostics/tests; not sufficient as retry-stable logical identity |
| Session + request ID | Transport-local pair | Still not proof of one logical user action |
| Fresh server UUID | One received dispatch | Safe conservative fallback; may double-meter a transport retry |
| Application logical action ID | One product-defined action across retries | Preferred when its lifecycle is well defined and validated |

## Multi-round tools

`protectMultiRoundTool()` is different: after the initial round, the wrapper carries the original trusted usage lease and logical operation ID through verified server-side flow state. Fresh MCP request IDs used during `input_required` resume do not create new reservations.

Do not copy that multi-round resume mechanism into arbitrary single-round deduplication.

## Observability

No new observer event is added for “unstable operation ID”. The adapter sees only the final string returned by the application and cannot truthfully determine how it was produced.

If an application chooses fresh-per-dispatch IDs, it may record that integration policy in its own bounded static configuration/telemetry. Do not emit raw operation IDs, request IDs, principals, or tool arguments as high-cardinality metrics labels.

## Summary

When there is no trustworthy retry-stable logical key, **fresh per dispatch is safer than guessing**. If the product needs one-charge-across-retry behavior, introduce an explicit application-level logical action ID and define its lifecycle; do not derive it from JSON-RPC request identity.
