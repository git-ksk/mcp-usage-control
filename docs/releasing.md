# Release policy

[English](releasing.md) | [日本語](releasing.ja.md)

## Release surfaces

GitHub/source releases and npm registry publication are separate operations.

The pre-1.0 release line contains five publishable npm packages:

- `mcp-usage-control`
- `mcp-usage-control-mcp`
- `mcp-usage-control-redis`
- `mcp-usage-control-cloudflare`
- `mcp-usage-control-firestore`

A GitHub Release may be created before npm publication. Until registry publication is explicitly authorized, use the repository checkout or local tarballs documented in [Use from source / local tarballs](using-from-source.md).

All five publishable packages use the same release version and the same supported Node.js floor.

## Versioning

Semantic Versioning is used with the normal pre-1.0 caveat: a minor release may intentionally include breaking API changes.

- patch: fixes preserving the intended public contract;
- minor: features and, before 1.0, intentional breaking API changes;
- major: 1.0+ compatibility boundary.

Breaking changes are called out prominently even when they occur in a pre-1.0 minor release.

## Supported Node.js runtime

The supported v1 runtime matrix is **Node.js 22 and 24**, with package metadata declaring `engines.node >=22`. Node.js 20 is EOL and is not a supported v1 runtime or required CI context.

## Required release-safety gate

`main` keeps the existing protected check names while making their meaning explicit:

- `test (22)` is the protected aggregate release-safety context. Node 22/24 are the supported runtime matrix; Node 20 is no longer a required context.
- `test (22)` is the aggregate v1 release-safety required context. It requires the complete Node/Redis/package/tarball/clean-consumer matrix and, when relevant paths changed, Cloudflare workerd and Firestore Emulator evidence.
- provider jobs are accepted as `skipped` only when the path classifier explicitly marks them non-applicable.
- docs-only changes take the lightweight Node path and skip provider integration without leaving either required context pending.
- a missing/unknown diff base runs all release-safety evidence conservatively.

Standalone `cloudflare-safety` and `firestore-safety` workflows remain useful diagnostic evidence, but the protected aggregate `test (22)` context no longer depends on administrators separately adding those provider contexts to branch protection.

## Pre-1.0 release gate

A pre-1.0 GitHub/source release is ready only when the applicable surfaces satisfy these gates:

- multi-budget admission is all-or-nothing in Memory, Redis, Cloudflare, and Firestore stores where applicable;
- idempotency scope and bounded tombstone retention are documented/tested;
- pending -> cost-liable -> settled crash semantics are tested;
- MCP success, `isError`, thrown errors, classifier failure, and settlement ambiguity are tested directly and through the official SDK path;
- `input_required` has an explicit support boundary or tested opt-in multi-round path;
- provider-neutral observability is secret-conscious and isolated from enforcement state;
- Redis server-time behavior and durability limitations are documented;
- Cloudflare Durable Objects + SQLite behavior, schema versioning, remote ACK ambiguity/reconciliation, gateway authentication, maintenance/pruning boundaries, and lazy cleanup/cost behavior are documented/tested;
- Firestore transactional multi-budget behavior, shared-document contention/hotspot risk, host-clock lease semantics, expiry recovery, and server-client compatibility are documented/tested;
- package names/exports/files are verified;
- all public package manifests declare the frozen supported Node.js floor;
- `pnpm-lock.yaml` is committed and CI uses `--frozen-lockfile`;
- npm-pack tarballs are smoke-tested and do not contain workspace protocol dependencies;
- clean-consumer imports pass on every supported Node.js major selected for the release;
- Cloudflare is exercised against local workerd and Firestore against the Local Emulator Suite whenever the aggregate path classifier requires them;
- English/Japanese user documentation matches the tagged code.

## GitHub/source release procedure

1. update package versions, changelog, and bilingual docs;
2. require aggregate `test (22)` release-safety evidence for the release PR, including Node.js 22/24, real Redis, package/tarball/clean-consumer checks, peer-compatibility evidence, and applicable provider integration;
3. verify any adapter-specific deployed dogfood requirement that is outside public CI;
4. merge the release PR to protected `main`;
5. tag the exact tested commit as `vX.Y.Z`;
6. let the `GitHub Release` workflow prove that the tagged SHA is reachable from `main` and has a successful exact-SHA aggregate `test (22)` check;
7. validate/package the five tarballs once, install those exact bytes in a clean consumer, generate `SHA256SUMS`, and create GitHub artifact attestations;
8. create the GitHub Release with those exact validated tarballs plus the checksum manifest. Existing release assets are verified byte-for-byte on a rerun rather than silently replaced.

The `GitHub Release` workflow never publishes to npm. A tag that is not reachable from protected `main`, or whose exact SHA lacks successful `test (22)` evidence, is not release-authorized even if the tag itself exists.

## npm publication procedure

npm publication is a later, explicit operation. It must not happen merely because a Git tag or GitHub Release exists.

1. verify npm package-name availability/ownership;
2. perform the final public-contract review;
3. configure/verify npm Trusted Publishing or a one-time bootstrap credential as appropriate;
4. confirm the GitHub Release/tag to publish;
5. manually run the `Publish npm` workflow with its explicit confirmation input; it downloads the selected GitHub Release tarballs and verifies `SHA256SUMS` instead of repacking them;
6. publish those exact validated/attested release tarball bytes in dependency order: core -> MCP / Redis / Cloudflare / Firestore adapters;
7. verify registry metadata and installation from a clean consumer project on the supported Node.js floor.

Prefer npm Trusted Publishing / OIDC on GitHub-hosted runners. Do not add long-lived npm tokens to repository files, logs, or release artifacts.

## npm publication runtime

The manual publication workflow currently runs on Node.js 24. Node 24 is a supported runtime and part of the normal release CI evidence matrix, so publication tooling does not rely on a Node major outside the tested public-package matrix.

## Release notes

Each release should state:

- user-visible features/fixes;
- changes to accounting/security invariants;
- breaking API/configuration changes;
- Redis/Cloudflare/Firestore storage or migration considerations;
- supported Node.js/MCP SDK/Redis/Cloudflare/Firestore test/runtime versions;
- known limitations, especially around multi-round flows and store-specific contention/time semantics;
- whether npm publication is included or deferred.

## Storage schema

Redis, Cloudflare, and Firestore storage layouts are implementation details but changes can affect deployments carrying existing enforcement state. Any post-v0.1 change that cannot safely read existing state must include a prominent migration/reset note.

## Emergency / known-bad releases

Use [Known-bad release containment and emergency hotfix runbook](incident-response.md). A generic rollback is never assumed safe for persisted enforcement state.

## Security fixes

Vulnerabilities enabling quota bypass, double spending, unauthorized entitlement access, cross-tenant replay, crash-after-cost refunds, inconsistent settlement, unauthenticated remote-store access, or sensitive observability leakage follow [SECURITY.md](../SECURITY.md). Coordinate disclosure before publishing exploit details.
