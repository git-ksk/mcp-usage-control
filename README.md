# mcp-usage-control

[![CI](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml/badge.svg)](https://github.com/git-ksk/mcp-usage-control/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md)

**Concurrency-safe usage enforcement for MCP tool execution.**

> Status: pre-alpha. The API and package names are not stable yet.

`mcp-usage-control` is a provider-neutral runtime for enforcing entitlements and usage budgets around Model Context Protocol (MCP) tool execution.

It is deliberately not a payment processor, MCP gateway, OAuth provider, or generic rate limiter. The target problem is safe admission and settlement when agents retry, execute tools concurrently, time out, or fail after an upstream cost has already been incurred.

## Core lifecycle

```text
principal -> policy/entitlement -> quote -> atomic reserve -> execute -> settle
```

The key distinction is **settlement**, not automatic rollback. A failed tool call may still have consumed an upstream API, database, or compute resource, so failures are not refunded by default.

## Current scaffold

- `@mcp-usage-control/core`
  - principal-scoped admission
  - policy-driven credit quotes
  - pre-execution reservation
  - explicit outcome-aware settlement
  - duplicate operation protection
  - reservation TTLs
  - in-memory reference store
- `@mcp-usage-control/mcp`
  - adapter for `@modelcontextprotocol/server` v2
  - conservative error settlement by default
  - explicit hooks for actual-cost classification

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

For an MCP tool handler, `protectTool()` reserves before execution and settles afterwards. On an unclassified exception it charges the full reservation; applications should return a lower error cost only when they can prove the metered resource was not consumed.

## Safety invariants

1. A quota check and reservation are one store operation; `check -> execute -> record` is not the model.
2. The same principal/operation ID cannot obtain two active reservations.
3. `actualUnits` cannot exceed the amount reserved in the current v0.1 model.
4. Repeating the same settlement is idempotent; conflicting settlements fail.
5. Reservation expiry releases abandoned in-flight units.
6. Errors are charged conservatively unless the application explicitly classifies them otherwise.

See [Architecture](docs/architecture.md) for the design boundaries.

## Planned v0.1

- production Redis adapter with atomic scripts
- multi-budget admission (for example daily + monthly + tenant budgets)
- better operation tombstone/expiry policy
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

CI tests Node.js 20 and 22.

## License

Apache-2.0
