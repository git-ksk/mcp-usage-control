# Release policy

[English](releasing.md) | [日本語](releasing.ja.md)

## Release packages

The v0.1 release line is prepared to publish three public npm packages once the first registry publication is authorized:

- `mcp-usage-control`
- `mcp-usage-control-mcp`
- `mcp-usage-control-redis`

Until that publication completes, use the repository checkout or local tarballs documented in [Use from source / local tarballs](using-from-source.md). All packages use the same release version in v0.1.x.

## Versioning

Semantic Versioning is used with the normal pre-1.0 caveat: a minor release may intentionally include breaking API changes.

- patch: fixes preserving the intended public contract;
- minor: features and, before 1.0, intentional breaking API changes;
- major: 1.0+ compatibility boundary.

Breaking changes are called out prominently even when they occur in a pre-1.0 minor release.

## v0.1.0 gate

The first release is considered ready only when:

- multi-budget admission is all-or-nothing in Memory and Redis stores;
- idempotency scope and bounded tombstone retention are documented/tested;
- pending -> cost-liable -> settled crash semantics are tested;
- MCP success, `isError`, thrown errors, classifier failure, and settlement ambiguity are tested directly and through the official SDK path;
- `input_required` has an explicit v0.1 support boundary;
- provider-neutral observability is best-effort, non-blocking, secret-conscious, and isolated from enforcement state;
- Memory/Redis expiry recovery observability and high-cardinality guidance are documented/tested;
- Redis server-time behavior and durability limitations are documented;
- package names/exports/files are verified;
- `pnpm-lock.yaml` is committed and CI uses `--frozen-lockfile`;
- package tarballs are smoke-tested in CI and do not contain workspace protocol dependencies;
- English/Japanese user documentation matches the tagged code;
- the release mechanism does not require committing or logging npm credentials.

## Release procedure

1. update package versions, changelog, and bilingual docs;
2. run Node.js 20/22 CI with real Redis and frozen dependencies;
3. pack all public packages and verify tarball contents;
4. merge the release PR to `main`;
5. tag the exact tested commit as `vX.Y.Z`;
6. publish packages in dependency order: core -> MCP -> Redis;
7. create the GitHub Release from the same tag;
8. verify registry metadata and installation from a clean consumer project.

Prefer npm Trusted Publishing / OIDC on GitHub-hosted runners when the npm package configuration supports it. Do not add long-lived npm tokens to repository files, logs, or release artifacts.

## Release notes

Each release should state:

- user-visible features/fixes;
- changes to accounting/security invariants;
- breaking API/configuration changes;
- Redis schema/migration considerations;
- supported Node.js/MCP SDK/Redis versions;
- known limitations, especially MCP multi-round support;
- npm package names and GitHub tag.

## Redis schema

The Redis storage layout is an implementation detail but changes can affect deployments carrying existing enforcement state. Any post-v0.1 change that cannot safely read existing state must include a prominent migration/reset note.

## Security fixes

Vulnerabilities enabling quota bypass, double spending, unauthorized entitlement access, cross-tenant replay, crash-after-cost refunds, inconsistent settlement, or sensitive observability leakage follow [SECURITY.md](../SECURITY.md). Coordinate disclosure before publishing exploit details.
