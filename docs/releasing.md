# Release policy

[English](releasing.md) | [日本語](releasing.ja.md)

## Release packages

The v0.1 release line is prepared to publish four public npm packages once the first registry publication is authorized:

- `mcp-usage-control`
- `mcp-usage-control-mcp`
- `mcp-usage-control-redis`
- `mcp-usage-control-cloudflare`

Until that publication completes, use the repository checkout or local tarballs documented in [Use from source / local tarballs](using-from-source.md). All packages use the same release version in v0.1.x.

## Versioning

Semantic Versioning is used with the normal pre-1.0 caveat: a minor release may intentionally include breaking API changes.

- patch: fixes preserving the intended public contract;
- minor: features and, before 1.0, intentional breaking API changes;
- major: 1.0+ compatibility boundary.

Breaking changes are called out prominently even when they occur in a pre-1.0 minor release.

## v0.1.0 gate

The first release is considered ready only when:

- multi-budget admission is all-or-nothing in Memory, Redis, and Cloudflare stores where applicable;
- idempotency scope and bounded tombstone retention are documented/tested;
- pending -> cost-liable -> settled crash semantics are tested;
- MCP success, `isError`, thrown errors, classifier failure, and settlement ambiguity are tested directly and through the official SDK path;
- `input_required` has an explicit v0.1 support boundary;
- provider-neutral observability is best-effort, not awaited for returned promises, secret-conscious, and isolated from enforcement state;
- synchronous observer work is documented as inline/lightweight and replay de-duplication semantics are explicit;
- Memory/Redis/Cloudflare expiry recovery observability and high-cardinality guidance are documented/tested;
- Redis server-time behavior and durability limitations are documented;
- Cloudflare Durable Objects + SQLite behavior, remote ACK ambiguity, gateway authentication boundary, and lazy cleanup/cost behavior are documented/tested;
- package names/exports/files are verified;
- `pnpm-lock.yaml` is committed and CI uses `--frozen-lockfile`;
- package tarballs are smoke-tested in CI and do not contain workspace protocol dependencies;
- the Cloudflare adapter is exercised against local workerd, not only mocks;
- English/Japanese user documentation matches the tagged code;
- the release mechanism does not require committing or logging npm credentials.

## Release procedure

1. update package versions, changelog, and bilingual docs;
2. run Node.js 20/22 CI with real Redis and frozen dependencies;
3. run the Cloudflare workerd integration workflow;
4. pack all public packages and verify tarball contents;
5. merge the release PR to `main`;
6. tag the exact tested commit as `vX.Y.Z`;
7. publish packages in dependency order: core -> MCP / Redis / Cloudflare adapters;
8. create the GitHub Release from the same tag;
9. verify registry metadata and installation from a clean consumer project.

Prefer npm Trusted Publishing / OIDC on GitHub-hosted runners when the npm package configuration supports it. Do not add long-lived npm tokens to repository files, logs, or release artifacts.

## Release notes

Each release should state:

- user-visible features/fixes;
- changes to accounting/security invariants;
- breaking API/configuration changes;
- Redis/Cloudflare storage or migration considerations;
- supported Node.js/MCP SDK/Redis/Cloudflare test/runtime versions;
- known limitations, especially MCP multi-round support;
- npm package names and GitHub tag.

## Storage schema

Redis and Cloudflare storage layouts are implementation details but changes can affect deployments carrying existing enforcement state. Any post-v0.1 change that cannot safely read existing state must include a prominent migration/reset note.

## Security fixes

Vulnerabilities enabling quota bypass, double spending, unauthorized entitlement access, cross-tenant replay, crash-after-cost refunds, inconsistent settlement, unauthenticated remote-store access, or sensitive observability leakage follow [SECURITY.md](../SECURITY.md). Coordinate disclosure before publishing exploit details.
