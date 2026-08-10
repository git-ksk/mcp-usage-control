# Getting started

[English](getting-started.md) | [日本語](getting-started.ja.md)

`mcp-usage-control` is currently pre-alpha and its workspace packages are intentionally private. This guide therefore starts from the repository source rather than an npm installation.

## Requirements

- Node.js 20 or later
- pnpm 10
- Redis 7 only when running the Redis integration tests or using the Redis adapter

## Clone and verify

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install
pnpm check
```

`pnpm check` builds all workspace packages and runs their tests. CI exercises Node.js 20 and 22 and starts a real Redis 7 service for Redis integration tests.

## Mental model

The core flow is:

```text
principal -> policy -> quote -> atomic reserve -> execute -> settle
                                 ^              |
                                 |--- renew -----|
```

A policy decides whether a request is eligible and how many units should be reserved. The store performs quota comparison and reservation creation atomically. A successful reservation becomes a renewable lease, and the caller settles the actual consumption after execution.

A failed tool call is not automatically free. If upstream work has already consumed a metered resource, settlement should charge that cost.

## Minimal in-memory example

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

if (!admission.allowed) {
  throw new Error(`Usage denied: ${admission.reason}`);
}

try {
  // Perform the metered work here.
  await admission.lease.settle(1, 'success');
} catch (error) {
  // If execution and settlement are separated in your application, classify
  // the actual units based on whether the metered work was incurred.
  throw error;
}
```

The in-memory store is intended for tests and local development. Production deployments should use a store that implements the atomicity and failure semantics described in [Architecture](architecture.md).

## Production Redis store

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from '@mcp-usage-control/redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const store = new RedisUsageStore(redis);
const control = new UsageControl(store, policy);
```

Use window-qualified budget keys so accounting windows are explicit:

```text
month:user-42:2026-08
day:user-42:2026-08-10
```

The adapter does not infer budget reset dates. See [Redis adapter](redis.md) before production use.

## MCP tool handlers

For `@modelcontextprotocol/server` v2, use `protectTool()` so reserve, lease heartbeat, error classification, and settlement stay around the handler boundary. See [MCP integration](mcp-integration.md).

## Before production use

This repository is still pre-alpha. In particular:

- package names and public APIs are not yet stable;
- one reservation currently targets one budget;
- atomic multi-budget admission is planned before v0.1;
- strict provider-specific fencing after lease loss is outside the generic core;
- authentication and principal derivation are application responsibilities.

Review [Architecture](architecture.md), [Security policy](../SECURITY.md), and [Redis adapter](redis.md) before deploying an enforcement path.