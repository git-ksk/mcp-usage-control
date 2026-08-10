# Support

[English](SUPPORT.md) | [日本語](SUPPORT.ja.md)

`mcp-usage-control` is currently a pre-alpha open-source project. Community support is best-effort and there is no commercial support SLA.

## Before opening an issue

Check:

- [Getting started](docs/getting-started.md)
- [MCP integration](docs/mcp-integration.md)
- [Architecture](docs/architecture.md)
- [Redis adapter](docs/redis.md)
- existing GitHub issues

For local development, run:

```console
pnpm install
pnpm check
```

If the problem concerns Redis, note the Redis version and whether the failure happens under concurrency, retry, expiry, or network/storage failure conditions.

## Bug reports

Use the bug-report issue template. Include:

- commit SHA or version;
- Node.js version;
- storage adapter and Redis version if applicable;
- minimal reproduction;
- expected vs actual behavior;
- whether the issue involves duplicate calls, concurrency, retry, lease expiry, or settlement;
- sanitized logs or error messages.

Do not include credentials, tokens, cookies, connection strings with secrets, raw production principal IDs, or private customer data.

## Feature requests

Use the feature-request template and explain the intended use case, required safety invariant, and why the change belongs in core versus an adapter.

## Security issues

Do not use a public issue for a vulnerability that could enable quota bypass, double spending, unauthorized access, cross-tenant leakage, or inconsistent settlement. Follow [SECURITY.md](SECURITY.md).

## Questions about current limitations

Known pre-alpha limitations include:

- one budget per reservation;
- package names and public APIs are not stable;
- strict provider-specific fencing after lease loss is outside the generic core;
- billing, payment, authentication, and analytics backends are not built into core.

If a question is answered by one of these boundaries, an issue may still be useful when it identifies a concrete documentation gap or proposes a scoped adapter.