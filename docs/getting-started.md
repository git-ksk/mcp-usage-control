# Getting started

[English](getting-started.md) | [日本語](getting-started.ja.md)

`mcp-usage-control` is currently pre-alpha and its workspace packages are intentionally private. This guide therefore starts from repository source rather than npm installation.

## Requirements

- Node.js 20 or later
- pnpm 10
- Redis 7 only when running Redis integration tests or using the Redis adapter

## Clone and verify

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install
pnpm check
```

`pnpm check` builds all workspace packages and runs their tests. CI exercises Node.js 20/22, real Redis 7, and the official MCP SDK v2 client/handler integration path.

> Reproducible release installs are not finalized yet: `pnpm-lock.yaml` will be committed and CI switched to frozen installs before v0.1.

## Mental model

```text
principal -> policy -> quote -> atomic reserve -> mark liable -> execute -> settle
                                 ^                          |
                                 |----------- renew --------|
```

A policy decides eligibility and the maximum units to reserve. The store performs quota comparison and reservation creation atomically.

A reservation is initially pending. Immediately before metered execution begins, call `markLiable()`. Pending expiry can release capacity; cost-liable expiry retains the full reservation so a worker/process crash after execution starts cannot become a refund.

A failed tool call is not automatically free. If upstream work consumed a metered resource, settlement should charge that cost.

## Minimal core example

```ts
import {
  MemoryUsageStore,
  UsageControl,
  type UsagePolicy,
} from '@mcp-usage-control/core';

const policy: UsagePolicy = {
  quote(request) {
    return {
      decision: 'allow',
      units: request.tool === 'full_export' ? 5 : 1,
      budget: {
        key: `month:${request.principal.id}:2026-08`,
        limit: request.principal.plan === 'pro' ? 2_000 : 100,
      },
    };
  },
};

const control = new UsageControl(new MemoryUsageStore(), policy);
const admission = await control.reserve({
  operationId: 'request-123',
  principal: { id: 'user-42', plan: 'free' },
  tool: 'search',
  args: { query: 'example' },
});

if (!admission.allowed) throw new Error('usage denied');

await admission.lease.markLiable();
try {
  const result = await performMeteredWork();
  await admission.lease.settle(1, 'success');
  return result;
} catch (error) {
  // Settle the actual incurred cost. Use zero only if you can prove the
  // metered resource was not consumed.
  await admission.lease.settle(admission.lease.reservedUnits, 'error');
  throw error;
}
```

The in-memory store is intended for tests and local development.

## Production Redis store

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from '@mcp-usage-control/redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
const store = new RedisUsageStore(redis);
const control = new UsageControl(store, policy);
```

Use window-qualified budget keys such as:

```text
month:user-42:2026-08
day:user-42:2026-08-10
```

The adapter does not infer reset dates. Lease timing is derived from Redis server time. Review [Redis adapter](redis.md), including persistence/failover durability and lazy-cleanup behavior, before production use.

## MCP tool handlers

For `@modelcontextprotocol/server` v2 **single-round** tools, use `protectTool()` so reserve, `markLiable`, heartbeat, MCP result classification, classifier fallback, and settlement stay around the handler boundary. See [MCP integration](mcp-integration.md).

MCP v2 `input_required` multi-round tools are not yet supported by `protectTool()`; do not wrap them in production until suspend/resume accounting is implemented.

## Before production use

This repository is still pre-alpha. In particular:

- package names and public APIs are not stable;
- one reservation currently targets one budget;
- atomic multi-budget admission is planned before v0.1;
- operation principal/tenant scoping is still being finalized;
- `input_required` multi-round accounting is not implemented;
- provider-specific fencing after lease loss is outside the generic core;
- Redis atomicity does not itself guarantee persistence/failover durability;
- authentication and principal derivation are application responsibilities.

Review [Architecture](architecture.md), [Security policy](../SECURITY.md), and [Redis adapter](redis.md) before deploying an enforcement path.