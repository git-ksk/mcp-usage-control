# Release policy

[English](releasing.md) | [日本語](releasing.ja.md)

`mcp-usage-control` is currently pre-alpha. The repository is public, but workspace packages remain `private: true` until package names and public contracts are intentionally reviewed.

## Before v0.1

Until the first tagged v0.1 release:

- `main` is the only supported development line;
- public TypeScript APIs may change without a deprecation period;
- package names may change;
- documentation describes current `main` behavior unless it explicitly names a tag;
- changes to accounting invariants should include migration notes in the pull request.

Do not depend on an unpublished workspace package name as if it were a stable npm contract.

## v0.1 release gate

The first registry release should not happen until at least the following are complete:

- atomic multi-budget admission has an intentionally reviewed all-or-nothing contract;
- idempotency, operation scoping, tombstone, cancellation and expiry semantics are documented and tested;
- pending -> cost-liable -> settled transitions and crash-after-execution-start recovery are covered by reference and Redis tests;
- MCP normal success, `{ isError: true }`, thrown errors, classifier failures and settlement ambiguity are covered through both wrapper tests and the official SDK client/handler integration path;
- MCP v2 `input_required` has either real reservation suspend/resume support or an intentionally finalized/documented support boundary;
- Redis server-time expiry semantics and durability limitations are documented;
- core, MCP, and Redis package names are verified on npm;
- `pnpm-lock.yaml` is committed and CI uses a frozen lockfile;
- package `files`/exports metadata is verified with pack smoke tests;
- release provenance/trusted publishing is configured where practical;
- no long-lived npm token is required by CI;
- English and Japanese user documentation is consistent with the tagged code.

## Versioning

Before 1.0, Semantic Versioning is used with the usual caveat that minor releases may contain breaking API changes.

- patch: fixes that preserve the intended public contract;
- minor: new features and, before 1.0, intentional breaking API changes;
- major: reserved for 1.0+ compatibility boundaries.

Breaking changes must be called out prominently in release notes even when they occur in a pre-1.0 minor release.

## Release notes

Each tagged release should summarize user-visible features/fixes, changes to safety/accounting invariants, breaking API/configuration changes, storage schema/migration considerations, supported Node.js/MCP SDK/Redis versions, and known limitations.

Do not publish secrets, tokens, connection strings, production identifiers, or private incident details in release artifacts.

## Security fixes

For a vulnerability that could enable quota bypass, double spending, unauthorized entitlement access, crash-after-cost refund, or inconsistent settlement, follow [SECURITY.md](../SECURITY.md). Coordinate disclosure before publishing detailed exploit information.