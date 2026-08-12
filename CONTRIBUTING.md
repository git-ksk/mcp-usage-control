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

## CI operating rules

The CI policy is to **keep safety checks intact while avoiding heavy work for documentation-only changes**.

### Required checks

Branch protection on `main` treats `test (20)` and `test (22)` as required checks.

Those check names are part of the repository's operating contract. If a workflow/job/matrix change would rename them, update branch protection as part of the same operational change. Do not rename the checks first and leave branch protection expecting the old names.

Do not use workflow-level `paths-ignore` to suppress a required workflow. If the workflow never starts, the required checks may never be created and a documentation-only pull request can become unmergeable.

### Documentation-only pull requests

A pull request is documentation-only when every changed path is one of the following:

- `docs/**`
- Markdown (`*.md`) at any repository depth

When every changed path matches that definition, the `changes` job classifies the pull request as documentation-only. The `test (20)` and `test (22)` jobs still run so branch protection sees the required check names, but each job takes only the lightweight success path and skips the heavy work:

- repository checkout
- Node / pnpm setup
- dependency installation
- Redis startup
- `pnpm check`
- public-package packing and package-content verification
- tarball installation in a clean consumer project

Keeping the required jobs alive while skipping their heavy steps is the repository's documentation-only CI strategy.

### When full CI is required

If even one non-documentation path changes, full CI runs. Source files, workflows, `package.json`, lockfiles, configuration files, and other non-Markdown paths all require the full path.

If CI cannot determine a usable base SHA or cannot reliably determine the changed paths, it fails safe by running full CI. An ambiguous change set must never become a reason to skip tests.

Changes to `.github/workflows/ci.yml` itself are non-Markdown changes and therefore always exercise full CI.

### Store-specific integration workflows

Cloudflare and Firestore integration tests are intentionally separate from the general CI workflow and are scoped to their relevant paths:

- Cloudflare Integration: `packages/cloudflare/**`, `packages/core/**`, `.github/workflows/cloudflare-integration.yml`
- Firestore Integration: `packages/firestore/**`, `packages/core/**`, `.github/workflows/firestore-integration.yml`

A Firestore-only change should not run Cloudflare Integration, and vice versa. Changes under `packages/core/**` intentionally run both because both adapters depend on the core contract.

When adding another store adapter or integration workflow, scope its triggers to the adapter itself, the shared packages it actually depends on, and the workflow file itself. If a broader trigger is necessary, explain the dependency reason in the pull request.

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