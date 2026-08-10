# Release policy

[English](releasing.md) | [日本語](releasing.ja.md)

## Release surfaces

GitHub/source releases and npm registry publication are separate operations.

The v0.1 line contains four publishable npm packages:

- `mcp-usage-control`
- `mcp-usage-control-mcp`
- `mcp-usage-control-redis`
- `mcp-usage-control-cloudflare`

A GitHub Release may be created before npm publication. Until registry publication is explicitly authorized, use the repository checkout or local tarballs documented in [Use from source / local tarballs](using-from-source.md).

All packages use the same release version in v0.1.x.

## Versioning

Semantic Versioning is used with the normal pre-1.0 caveat: a minor release may intentionally include breaking API changes.

- patch: fixes preserving the intended public contract;
- minor: features and, before 1.0, intentional breaking API changes;
- major: 1.0+ compatibility boundary.

Breaking changes are called out prominently even when they occur in a pre-1.0 minor release.

## v0.1.0 gate

The first GitHub/source release is ready only when:

- multi-budget admission is all-or-nothing in Memory, Redis, and Cloudflare stores where applicable;
- idempotency scope and bounded tombstone retention are documented/tested;
- pending -> cost-liable -> settled crash semantics are tested;
- MCP success, `isError`, thrown errors, classifier failure, and settlement ambiguity are tested directly and through the official SDK path;
- `input_required` has an explicit v0.1 support boundary;
- provider-neutral observability is secret-conscious and isolated from enforcement state;
- Redis server-time behavior and durability limitations are documented;
- Cloudflare Durable Objects + SQLite behavior, schema versioning, remote ACK ambiguity/reconciliation, gateway authentication, maintenance/pruning boundaries, and lazy cleanup/cost behavior are documented/tested;
- package names/exports/files are verified;
- `pnpm-lock.yaml` is committed and CI uses `--frozen-lockfile`;
- npm-pack tarballs are smoke-tested and do not contain workspace protocol dependencies;
- clean-consumer imports pass;
- Cloudflare is exercised against local workerd, and the deployed dogfood path is documented;
- English/Japanese user documentation matches the tagged code.

## GitHub/source release procedure

1. update package versions, changelog, and bilingual docs;
2. run Node.js 20/22 CI with real Redis and frozen dependencies;
3. run Cloudflare workerd integration;
4. pack all public packages and inspect tarball contents;
5. merge the release PR to `main`;
6. tag the exact tested commit as `vX.Y.Z`;
7. create the GitHub Release from the same tag and changelog entry.

The `GitHub Release` workflow never publishes to npm.

## npm publication procedure

npm publication is a later, explicit operation. It must not happen merely because a Git tag or GitHub Release exists.

1. verify npm package-name availability/ownership;
2. perform the final public-contract review;
3. configure/verify npm Trusted Publishing or a one-time bootstrap credential as appropriate;
4. confirm the GitHub Release/tag to publish;
5. manually run the `Publish npm` workflow with its explicit confirmation input;
6. publish in dependency order: core -> MCP / Redis / Cloudflare adapters;
7. verify registry metadata and installation from a clean consumer project.

Prefer npm Trusted Publishing / OIDC on GitHub-hosted runners. Do not add long-lived npm tokens to repository files, logs, or release artifacts.

## Release notes

Each release should state:

- user-visible features/fixes;
- changes to accounting/security invariants;
- breaking API/configuration changes;
- Redis/Cloudflare storage or migration considerations;
- supported Node.js/MCP SDK/Redis/Cloudflare test/runtime versions;
- known limitations, especially MCP multi-round support;
- whether npm publication is included or deferred.

## Storage schema

Redis and Cloudflare storage layouts are implementation details but changes can affect deployments carrying existing enforcement state. Any post-v0.1 change that cannot safely read existing state must include a prominent migration/reset note.

## Security fixes

Vulnerabilities enabling quota bypass, double spending, unauthorized entitlement access, cross-tenant replay, crash-after-cost refunds, inconsistent settlement, unauthenticated remote-store access, or sensitive observability leakage follow [SECURITY.md](../SECURITY.md). Coordinate disclosure before publishing exploit details.
