# Contributing

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md)

Thanks for contributing to `mcp-usage-control`.

This project treats quota/accounting behavior as correctness- and security-sensitive. Small-looking changes to reservation, liability, expiry, retry, classification, or settlement semantics can create oversubscription or under-accounting, so those changes need explicit invariant tests.

## Start contributing

Documentation fixes, examples, bug reproductions, and focused code changes are welcome. For a larger feature or storage-contract change, explain the use case in an issue first. Report vulnerabilities privately through [Security](SECURITY.md).

Use Node.js 22+ and **pnpm 10.15.0**, pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm example:free-plus
```

The example needs no external service. For runtime changes, run `pnpm check` and the integration tests relevant to the affected store. Some Redis integration tests are skipped without `REDIS_URL`; a local pass without it is not Redis integration evidence.

### Test with Redis

Start an isolated Redis 7 instance on a free local port:

```sh
docker run --detach --rm --name muc-contrib-redis -p 127.0.0.1:16379:6379 redis:7-alpine
docker exec muc-contrib-redis redis-cli ping
```

After `PONG`, run:

```sh
REDIS_URL=redis://127.0.0.1:16379 pnpm check
docker stop muc-contrib-redis
```

Stop the container when finished, including after a failed test. Cloudflare/workerd and Firestore Emulator use separate integration workflows; consult the provider guides for their setup. Never run these tests against production accounting state.

## CI operating rules

The source of truth is [ci.yml](.github/workflows/ci.yml). The aggregate check is named **`test (22)`**; it verifies every applicable job, rather than running only Node.js 22 tests itself. Preserve that check name when changing workflow structure, and coordinate any required-check configuration changes.

| Changed paths | Expected validation |
| --- | --- |
| Only `docs/**` and/or Markdown at any depth | `docs-only` checks out the repository and runs `git diff --check`; the aggregate check verifies its result |
| Any path outside those documentation patterns | Node.js 22/24 build/test/package checks, peer compatibility, and dependency review on PRs |
| Core, provider, or relevant CI workflow | Applicable Cloudflare/workerd and Firestore Emulator evidence, as selected by the workflow |
| Missing or unusable comparison base | Full validation conservatively |

Documentation-only changes skip runtime tests and package installation. Files such as SVGs under `docs/` still match `docs/**`. A non-Markdown file outside `docs/` takes the full path.

Do not suppress the entire required workflow with `paths-ignore`: an absent check can block merging. Provider workflows also classify scope internally and report aggregate safety checks. Check the actual workflow conditions when changing their triggers.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `packages/core` | Provider- and MCP-independent usage control |
| `packages/mcp` | MCP SDK v2 integration |
| `packages/redis` | Redis usage and MCP flow stores |
| `packages/cloudflare` | Durable Objects and authenticated remote access |
| `packages/firestore` | Server-side Firestore store |
| `examples` | Runnable examples |
| `docs` | Guides, contracts, and release evidence |

Keep provider-, protocol-, and billing-specific concerns outside core unless the abstraction requires them.

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
- For MCP tools without an input schema, require an explicit `noInput: true` mode rather than guessing from `{}` at runtime. Cover both the SDK's public no-input callback type and actual dispatch behavior in protocol tests.
- For MCP tools with an input schema, preserve validated `(args, ctx)` behavior.
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
