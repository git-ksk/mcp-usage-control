# Support

[English](SUPPORT.md) | [日本語](SUPPORT.ja.md)

`mcp-usage-control` is currently a pre-v1 open-source project. Community support is best-effort and there is no commercial support SLA.

## Supported runtime

The supported v1 runtime floor is **Node.js 22+**. Node.js 20 reached upstream EOL and is not part of the supported v1 runtime contract. The repository temporarily keeps a Node 20 CI job as compatibility-only evidence because the current branch-protection policy still requires that legacy check; passing that job does not restore Node 20 support.

## Before opening an issue

Check:

- [Getting started](docs/getting-started.md)
- [MCP integration](docs/mcp-integration.md)
- [Architecture](docs/architecture.md)
- [Redis adapter](docs/redis.md)
- existing GitHub issues

For local development, use Node.js 22 or later and run:

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

## Dependency advisories

Supported-line dependency and GitHub Actions advisories are triaged through the automated checks described in [SECURITY.md](SECURITY.md). Critical/high advisories should include the affected dependency/action, supported release impact, applicability/exploitability assessment, and safe target version when known.

## Security issues

Do not use a public issue for a vulnerability that could enable quota bypass, double spending, unauthorized access, cross-tenant leakage, or inconsistent settlement. Follow [SECURITY.md](SECURITY.md).

## Questions about current limitations

Known pre-v1 limitations include:

- public API/name freeze is completed through the v0.11 line rather than assumed from earlier source releases;
- npm registry publication remains deferred until the separately authorized first publish tracked in #6;
- stable first-class MCP Tasks wire/runtime integration remains deferred while the upstream surface is experimental;
- generic operation reconciliation is scalar-only; vector initial-reserve ambiguity remains fail closed unless separately proven;
- strict provider-specific fencing after lease loss is outside the generic core;
- billing, payment, authentication, and analytics backends are not built into core.

If a question is answered by one of these boundaries, an issue may still be useful when it identifies a concrete documentation gap or proposes a scoped adapter.
