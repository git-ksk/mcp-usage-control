# Redis MCP multi-round flow store

[English](redis-mcp-flow-store.md) | [日本語](redis-mcp-flow-store.ja.md)

`mcp-usage-control-redis/mcp-flow` provides a shared Redis implementation of the server-side flow-store contract used by `protectMultiRoundTool()`.

Use it when MCP `input_required` retry requests can land on different processes or instances and `MemoryMcpUsageFlowStore` is therefore insufficient.

## Setup

```ts
import { createClient } from 'redis';
import { RedisMcpUsageFlowStore } from 'mcp-usage-control-redis/mcp-flow';
import { protectMultiRoundTool } from 'mcp-usage-control-mcp';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const flowStore = new RedisMcpUsageFlowStore(redis);

const protectedTool = protectMultiRoundTool({
  control,
  tool: 'confirm-write',
  noInput: true,
  principal: ctx => trustedPrincipal(ctx),
  operationId: () => stableLogicalOperationId(),
  flowStore,
  requestState: { mint: payload => stateCodec.mint(payload) },
  suspendTtlMs: 5 * 60_000,
}, handler);
```

The Redis subpath is structurally compatible with the MCP package's `McpUsageFlowStore` contract; the Redis package does not import the MCP package at runtime.

## Atomic compare-and-consume

A suspended flow uses two Redis keys:

```text
<prefix>:{mcp-flow:<flowId>}:record
<prefix>:{mcp-flow:<flowId>}:binding
```

Both keys for one flow share one Redis Cluster hash tag, so Lua can manipulate them atomically. Different flow IDs use different hash tags and can distribute across cluster slots.

`consume(flowId, binding)` performs one Lua operation:

1. read the flow payload and stored binding digest;
2. fail closed if only one of the two keys exists;
3. return no flow on a binding mismatch **without deleting the legitimate flow**;
4. if the binding matches, delete both keys and return the payload in the same atomic script.

This makes a resume token one-time across processes. Under parallel contention, at most one caller receives the flow record.

## Binding

The trusted binding covers:

```text
principalId
tenantId
tool
canonical argsHash
```

The Redis binding key stores a SHA-256 digest of that tuple. The decoded record is checked against the current binding again after retrieval.

The flow ID is an opaque lookup identifier, not authorization proof. The client-round-tripped MCP `requestState` must still be integrity-verified by the MCP server before the flow ID is passed to this store.

## Expiry

`suspend()` receives the same absolute `expiresAt` used by the resumable usage lease.

The Lua script reads Redis server `TIME`, rejects a flow whose expiry is already in the past, and writes both keys with Redis `PXAT`. No application cleanup timer is required for normal suspended-flow expiry.

The Redis flow record and the usage reservation are separate states. Redis expiry removes only the resume capability. The underlying cost-liable usage lease follows its own `UsageStore` expiry semantics and conservatively retains the reserved charge if abandoned.

## Lost acknowledgement / process-loss semantics

The store deliberately does not retry its Lua calls automatically.

### Lost `suspend()` acknowledgement

The Redis write may have committed before the caller sees an error. The caller must treat suspension as ambiguous. `protectMultiRoundTool()` fails closed and does not fabricate a second flow.

### Lost `consume()` acknowledgement

The Lua script may already have atomically deleted the one-time token. Retrying `consume()` can therefore return missing even though the first claim succeeded. The safe behavior is to fail closed rather than re-enter the application handler blindly.

### Failure after a successful claim

Once a flow has been claimed, a process or transport can still fail before the business result reaches the caller. Reusing the usage resume token is intentionally not the recovery mechanism.

For destructive or externally metered work, retain application/business idempotency and result reconciliation. A future result cache/reconciliation layer, if used, should remain separate from the usage accounting state and use bounded retention.

## Payload privacy and codec

The **binding key is hashed**, but the default flow-record payload codec is JSON.

Unlike the main Redis `UsageStore` ledger, a resumable flow record is temporary trusted server-side workflow state. It contains `UsageLeaseResumeState`, which can include raw application accounting identity, tool name, budget keys, plan, and explicit observer metadata.

Therefore:

- treat the Redis deployment as trusted server-side infrastructure;
- do not put credentials, tool arguments, or other secrets into accounting identifiers/metadata;
- keep the flow payload compact; the adapter rejects encoded payloads larger than 64 KiB;
- if the Redis trust model requires confidentiality at rest beyond Redis/platform controls, supply a custom `RedisMcpUsageFlowCodec` that encrypts/authenticates the record before storage.

Example codec shape:

```ts
const flowStore = new RedisMcpUsageFlowStore(redis, {
  codec: {
    async encode(record) {
      return encryptAndAuthenticate(JSON.stringify(record));
    },
    async decode(payload) {
      return JSON.parse(await decryptAndVerify(payload));
    },
  },
});
```

The Lua binding comparison remains independent of the encoded record format.

## Failure policy

Redis/network/script failures are propagated. They are never converted into a successful resume and the store does not fall back to process memory or another flow ledger.

This mirrors the core usage-control policy: storage ambiguity reduces availability rather than weakening one-time accounting/execution guarantees.

## What this adapter does not provide

It does not provide:

- a generic workflow engine;
- completed business-result caching/replay;
- exactly-once arbitrary external side effects;
- a replacement for the MCP request-state signature/verification codec;
- a second usage ledger or fallback quota source.

Its job is narrowly to make the server-side suspended-flow claim durable/shared and atomic across MCP server instances.
