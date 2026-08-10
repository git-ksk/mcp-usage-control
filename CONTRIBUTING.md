# Contributing

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md)

Thanks for contributing to `mcp-usage-control`.

This project treats quota/accounting behavior as correctness- and security-sensitive. Small-looking changes to reservation, expiry, retry, or settlement semantics can create oversubscription or under-accounting, so contributions in those areas need explicit invariant tests.

## Development

Requirements:

- Node.js 20+
- pnpm 10
- Docker or a local Redis 7 instance when reproducing Redis integration behavior

Run the default verification suite:

```console
pnpm install
pnpm check
```

CI tests Node.js 20 and 22 and starts a real Redis 7 service for Redis integration tests.

## Repository layout

```text
packages/core    provider- and MCP-independent usage-control contract
packages/mcp     @modelcontextprotocol/server v2 integration
packages/redis   production Redis UsageStore adapter
docs             architecture and user guides
```

Keep storage-, protocol-, billing-, and provider-specific concerns outside `core` unless the abstraction itself genuinely requires them.

## Design rules

- Keep `@mcp-usage-control/core` independent of MCP SDKs and billing/payment providers.
- Do not split quota checking from reservation creation in production stores.
- Do not automatically refund all errors. Settlement must reflect whether metered cost was actually incurred.
- Treat operation IDs as idempotency inputs, not authentication credentials.
- Treat active reservations as renewable leases; crash recovery must not reclaim legitimate long-running work solely because its initial TTL elapsed.
- Do not blindly retry an ambiguous settlement write.
- Storage errors must not silently become an allow decision.
- Add concurrency, duplicate, expiry, retry, and ambiguous-failure tests when changing the corresponding semantics.
- Prefer small adapters over adding provider-specific behavior to the core.

See [Architecture](docs/architecture.md) before changing a safety invariant.

## Pull requests

Keep pull requests focused. In the description, explain:

1. what problem is being solved;
2. which usage/accounting invariant changes or is preserved;
3. which failure and concurrency cases were tested;
4. whether the change affects public API, storage state, or documentation;
5. any migration or compatibility impact.

For behavior changes, test both allowed and denied paths. Security-sensitive changes should also cover duplicate, concurrent, expiry, retry, and storage-failure cases where applicable.

## Documentation

User-facing documentation is maintained in English and Japanese. When a behavior, configuration option, public API, or operational warning changes, update both language versions in the same pull request whenever practical.

English is canonical for code identifiers. Do not translate package names, API symbols, Redis keys, error class names, or configuration field names.

The documentation index is [docs/README.md](docs/README.md).

## Commit and PR hygiene

- Never commit credentials, tokens, cookies, connection strings with secrets, or production identifiers.
- Avoid unrelated formatting/refactoring in a correctness-sensitive change.
- Add tests before relaxing an invariant.
- Prefer explicit failure behavior over hidden fallback behavior.
- Do not publish packages from a contribution branch.

## Reporting security issues

Do not open a public issue for a vulnerability that could enable quota bypass, double spending, unauthorized entitlement access, or inconsistent settlement. Follow [SECURITY.md](SECURITY.md) instead.

## Code of Conduct

Participation in this project is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).