# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**Concurrency-safe usage enforcement for MCP tool execution.**

> Status: pre-alpha. The API and package names are not stable yet. Workspace packages are intentionally not published to npm yet.

`mcp-usage-control` is a provider-neutral runtime for enforcing entitlements and usage budgets around Model Context Protocol (MCP) tool execution.

It is deliberately not a payment processor, MCP gateway, OAuth provider, or generic rate limiter. The target problem is safe admission and settlement when agents retry, execute tools concurrently, time out, run for a long time, fail after upstream cost, or disappear before settlement.

## Core lifecycle

```text
principal -> policy/entitlement -> quote -> atomic reserve -> mark liable -> execute -> settle
                                                ^                          |
                                                |----------- renew --------|
```

The key distinction is **settlement**, not automatic rollback. A failed tool call may still have consumed an upstream API, database, or compute resource.

A reservation starts pending. The execution boundary then marks it cost-liable. If a pending lease expires before execution starts, it can be released; if a cost-liable lease expires after execution starts, the full reservation is conservatively retained. This prevents a process crash after upstream work from becoming a refund.

## Current packages

- `@mcp-usage-control/core`
  - policy-driven credit quotes and principal-scoped admission
  - atomic reservation contract
  - pending -> cost-liable transition
  - renewable leases
  - explicit outcome-aware settlement
  - duplicate operation protection
  - in-memory reference store
- `@mcp-usage-control/mcp`
  - adapter for `@modelcontextprotocol/server` v2 **single-round** tool handlers
  - marks execution cost-liable before handler entry
  - automatic lease heartbeat by default
  - distinguishes normal success, MCP `isError: true`, and thrown errors
  - classifier failures fall back to a full conservative charge
  - ambiguous settlement failures are not blindly retried
  - MCP v2 `input_required` is explicitly unsupported until suspend/resume accounting lands
- `@mcp-usage-control/redis`
  - atomic Lua reserve / mark-liable / renew / settle transitions
  - Redis-server-time lease decisions; application clock skew is not used
  - state-dependent expiry recovery
  - bounded expiry and idempotency cleanup
  - collision-safe tuple encoding before operation hashing
  - Redis Cluster-compatible single hash-slot transaction domain
  - real Redis integration tests in CI

Workspace packages remain `private: true` during pre-alpha so names and public contracts can be finalized before the first registry release.

## Documentation

- **Start here:** [Getting started](docs/getting-started.md)
- **Using MCP SDK v2:** [MCP integration](docs/mcp-integration.md)
- **Design and invariants:** [Architecture](docs/architecture.md)
- **Production storage:** [Redis adapter](docs/redis.md)
- **API:** [API reference](docs/api-reference.md)
- **Release compatibility:** [Release policy](docs/releasing.md)
- **All docs:** [Documentation index](docs/README.md)

Project policies: [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Support](SUPPORT.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## Quick start from source

```console
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install
pnpm check
```

Requires Node.js 20+ and pnpm 10. CI tests Node.js 20 and 22, including real Redis 7 integration tests and official MCP SDK client/handler integration coverage.

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

For MCP single-round tool handlers, `protectTool()` reserves, marks the lease cost-liable, renews it while the handler runs, classifies the result, and settles afterwards. Unclassified errors and classifier failures charge conservatively.

For production Redis storage:

```ts
import { createClient } from 'redis';
import { RedisUsageStore } from '@mcp-usage-control/redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
const store = new RedisUsageStore(redis);
```

See [Redis adapter](docs/redis.md) before production use. Lua atomicity does not by itself guarantee persistence/failover durability; choose Redis HA/persistence to match your accounting requirements.

## Safety invariants

1. Quota comparison and reservation are one store operation; `check -> execute -> record` is not the model.
2. The same principal/operation ID cannot obtain two reservations during the replay-protection window.
3. Entering the metered execution boundary marks the lease cost-liable.
4. Expired pending reservations release capacity; expired cost-liable reservations retain the full charge.
5. Active long-running leases are renewable rather than reclaimed solely because the initial TTL elapsed.
6. `actualUnits` cannot exceed the amount reserved in the current model.
7. Repeating the same settlement is idempotent; conflicting settlements fail.
8. MCP `isError: true` results are not classified as success.
9. Cost-classification failures settle conservatively before surfacing an error.
10. Ambiguous settlement failures are surfaced and are not blindly retried.
11. Storage failures do not turn into an allow decision for new admission.
12. Redis lease time comes from Redis, not the application host clock.

See [Architecture](docs/architecture.md) for full design boundaries and distributed-lease limitations.

## Important current limitation: `input_required`

MCP v2 multi-round `input_required` flows need reservation suspend/resume semantics across fresh requests. `protectTool()` currently rejects those flows explicitly rather than silently charging every round or deadlocking on duplicate operation IDs. Do not wrap production `input_required` tools until dedicated support lands.

## Planned v0.1

- atomic multi-budget admission (for example daily + monthly + tenant budgets)
- finalized operation tombstone / principal-tenant scope semantics
- MCP `input_required` suspend/resume accounting or an intentionally finalized support boundary
- observability hooks
- committed `pnpm-lock.yaml`, frozen CI, package pack tests, and npm release workflow

Billing providers, OAuth providers, dashboards, and payment protocols remain out of scope for the core. OpenMeter, Unkey, Stripe, RevenueCat, and x402 are integration candidates rather than dependencies.

## Contributing

Contributions are welcome. Changes to reservation, liability, retry, expiry, or settlement behavior are correctness/security sensitive and should include concurrency and failure tests. See [CONTRIBUTING.md](CONTRIBUTING.md).

For vulnerabilities that could enable quota bypass, double spending, cross-tenant leakage, replay abuse, or inconsistent settlement, do not open a public issue; follow [SECURITY.md](SECURITY.md).

## License

Apache-2.0