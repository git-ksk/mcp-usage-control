# Contributing

Thanks for contributing to `mcp-usage-control`.

## Development

Requirements:

- Node.js 20+
- pnpm 10

Run:

```console
pnpm install
pnpm check
```

## Design rules

- Keep `@mcp-usage-control/core` independent of MCP SDKs and billing/payment providers.
- Do not split quota checking from reservation creation in production stores.
- Do not automatically refund all errors. Settlement must reflect whether metered cost was actually incurred.
- Treat operation IDs as idempotency inputs, not authentication credentials.
- Add concurrency and retry tests for changes to reserve/settle semantics.
- Prefer small adapters over adding provider-specific behavior to the core.

## Pull requests

Explain which usage invariant the change affects and include tests for both the allowed and denied paths. Security-sensitive changes should also cover duplicate, concurrent, and failure cases where applicable.
