# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**Concurrency-safe usage enforcement for MCP tool execution.**

> Status: pre-alpha. The API and package names are not stable yet.

`mcp-usage-control` is a provider-neutral runtime for enforcing entitlements and usage budgets around Model Context Protocol (MCP) tool execution.

It is deliberately not a payment processor, MCP gateway, OAuth provider, or generic rate limiter. The target problem is safe admission and settlement when agents retry, execute tools concurrently, time out, run for a long time, or fail after an upstream cost has already been incurred.

## Core lifecycle

```text
principal -> policy/entitlement -> quote -> atomic reserve -> execute -> settle
                                                ^              |
                                                |--- renew -----|
```

The key distinction is **settlement**, not automatic rollback. A failed tool call may still have consumed an upstream API, database, or compute resource, so failures are not refunded by default.

Reservations are renewable leases. The MCP adapter heartbeats an active lease while the handler runs so a legitimate long-running tool is not reclaimed as abandoned.

## Current packages

- `@mcp-usage-control/core`
  - principal-scoped admission
  - policy-driven credit quotes
  - pre-execution reservation
  - renewable leases
  - explicit outcome-aware settlement
  - duplicate operation protection
  - in-memory reference store
- `@mcp-usage-control/mcp`
  - adapter for `@modelcontextprotocol/server` v2
  - automatic lease heartbeat by default
  - conservative error settlement by default
  - explicit hooks for actual-cost classification
  - ambiguous settlement failures are not blindly retried
- `@mcp-usage-control/redis`
  - atomic Lua reserve / renew / settle transitions
  - bounded expiry and idempotency cleanup
  - hashed budget/operation identifiers
  - Redis Cluster-compatible single hash-slot transaction domain
  - real Redis integration tests in CI

Workspace packages are private during the pre-alpha phase so package naming can be finalized before the first registry release.

## Example

```ts
const control = new UsageControl(
  new MemoryUsageStore(),
  {
    quote(request) {
      return {
        decision: 'allow',
        units: request.tool === 'full_export' ? 5 : 1,
        budget: {
          key: `month:${request.principal.id}:2026-08`,
          limit: request.principal.plan === 'pro' ? 2000 : 100,
        },
      };
    },
  },
);
```

For an MCP tool handler, `protectTool()` reserves before execution, renews the lease while the handler is in flight, and settles afterwards. On an unclassified exception it charges the full reservation; applications should return a lower error cost only when they can prove the metered resource was not consumed.

For production Redis storage:

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from '@mcp-usage-control/redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const store = new RedisUsageStore(redis);
```

See [Redis adapter](docs/redis.md) for the key model, cleanup behavior, and Redis Cluster trade-offs.

## Safety invariants

1. A quota check and reservation are one store operation; `check -> execute -> record` is not the model.
2. The same principal/operation ID cannot obtain two active reservations.
3. Active long-running reservations are renewable rather than reclaimed solely because the initial TTL elapsed.
4. `actualUnits` cannot exceed the amount reserved in the current v0.1 model.
5. Repeating the same settlement is idempotent; conflicting settlements fail.
6. Expired abandoned reservations release their in-flight units.
7. Errors are charged conservatively unless the application explicitly classifies them otherwise.
8. Ambiguous settlement failures are surfaced and are not blindly retried.
9. Storage failures do not turn into an allow decision.

See [Architecture](docs/architecture.md) for the design boundaries.

## Planned v0.1

- atomic multi-budget admission (for example daily + monthly + tenant budgets)
- finalized operation tombstone/expiry semantics
- observability hooks
- MCP integration examples
- package naming and npm release workflow

Billing providers, OAuth providers, dashboards, and payment protocols remain out of scope for the core. OpenMeter, Unkey, Stripe, RevenueCat, and x402 are integration candidates rather than dependencies of the runtime.

## Development

Requires Node.js 20+ and pnpm 10.

```console
pnpm install
pnpm check
```

CI tests Node.js 20 and 22, including real Redis integration tests.

## License

Apache-2.0
