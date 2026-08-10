# mcp-usage-control

Concurrency-safe usage enforcement for MCP tool execution.

> Status: pre-alpha. The API is not stable yet.

`mcp-usage-control` is a small, provider-neutral runtime for enforcing entitlements and usage budgets around Model Context Protocol (MCP) tool execution.

The core problem it targets is not payment processing or generic rate limiting. It is safe admission and settlement when agents retry, execute tools concurrently, time out, or fail after upstream cost has already been incurred.

## Design goal

```text
principal -> entitlement -> quote -> atomic reserve -> execute -> settle
```

A reservation is created before a tool runs, then settled with the actual outcome/cost instead of assuming every failure should be refunded.

## Planned v0.1

- principal / tenant scoped usage
- tool entitlement checks
- fixed and dynamic credit quotes
- atomic reservation
- outcome-aware settlement
- idempotency and reservation TTLs
- in-memory reference store
- Redis production adapter
- MCP integration package

Billing providers, OAuth providers, dashboards, and payment protocols are deliberately out of scope for the core.

## License

Apache-2.0
