# Contributing

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md)

Thanks for contributing to `mcp-usage-control`.

This project treats quota/accounting behavior as correctness- and security-sensitive. Small-looking changes to reservation, liability, expiry, retry, classification, or settlement semantics can create oversubscription or under-accounting, so those changes need explicit invariant tests.

## Development

Requirements:

- Node.js 20+
- pnpm 10
- Docker or a local Redis 7 instance when reproducing Redis integration behavior

```console
pnpm install
pnpm check
```

CI tests Node.js 20/22, real Redis 7, and MCP SDK v2 protocol integration behavior.

## Repository layout

```text
packages/core    provider- and MCP-independent usage-control contract
packages/mcp     @modelcontextprotocol/server v2 integration
packages/redis   production-oriented Redis UsageStore adapter
docs             architecture and user guides
```

Keep storage-, protocol-, billing-, and provider-specific concerns outside `core` unless the abstraction itself genuinely requires them.

## Design rules

- Keep `core` independent of MCP SDKs and billing/payment providers.
- Do not split quota checking from reservation creation in production stores.
- Preserve the `pending -> cost-liable -> settled` distinction. An execution-started crash must not silently become a refund.
- Do not automatically refund all errors; settlement must reflect incurred metered cost.
- Treat cost-classification hooks as fallible/untrusted extension points and preserve a conservative fallback.
- Treat operation IDs as idempotency inputs, not authentication credentials.
- Treat active reservations as renewable leases; do not reclaim legitimate long-running work solely because its initial TTL elapsed.
- Do not blindly retry ambiguous writes.
- Storage errors must not silently become an allow decision.
- MCP adapters must cover both SDK callback forms: `(ctx)` for no-input-schema tools and `(args, ctx)` when an input schema exists.
- Do not treat MCP `{ isError: true }` as normal success.
- Do not add `input_required` support without explicit multi-round suspend/resume accounting semantics.
- Keep Redis atomicity and durability claims separate.
- Prefer small adapters over provider-specific behavior in core.

See [Architecture](docs/architecture.md) before changing a safety invariant.

## Pull requests

Keep pull requests focused. Explain the problem, affected invariant, failure/concurrency cases tested, API/storage/documentation impact, and migration/compatibility impact.

For behavior changes, cover allowed and denied paths. Where relevant, also cover duplicate/retry, concurrency, pending vs cost-liable expiry, lease renewal/loss, process-crash recovery, classifier failure, ambiguous acknowledgements, and MCP protocol-level behavior.

Changes to MCP adapter behavior should include a direct unit test and, where SDK semantics matter, an official SDK `Client + createMcpHandler` integration test.

## Documentation

User-facing documentation is maintained in English and Japanese. When behavior, configuration, public API, or an operational warning changes, update both languages in the same pull request whenever practical.

English is canonical for code identifiers. Do not translate package names, API symbols, Redis keys, error class names, or configuration fields.

The documentation index is [docs/README.md](docs/README.md).

## Commit and PR hygiene

- Never commit credentials, tokens, cookies, connection strings with secrets, or production identifiers.
- Avoid unrelated formatting/refactoring in a correctness-sensitive change.
- Add tests before relaxing an invariant.
- Prefer explicit failure behavior over hidden fallback behavior.
- Do not publish packages from a contribution branch.

## Reporting security issues

Do not open a public issue for a vulnerability that could enable quota bypass, double spending, unauthorized entitlement access, crash-after-cost refund, cross-tenant access, or inconsistent settlement. Follow [SECURITY.md](SECURITY.md).

## Code of Conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).