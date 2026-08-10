# Cloudflare SQLite schema migrations

`mcp-usage-control-cloudflare` versions the SQLite schema owned by each usage-control Durable Object transaction domain.

## Current schema

The current schema version is **1**.

Version 1 contains:

- `budgets`
- `reservations`
- `reservations_active_expiry`
- `reservations_tombstone_expiry`
- `usage_control_schema`, a single-row metadata table containing the schema version

The schema metadata is internal adapter state. Do not modify it from application code.

## Startup behavior

Schema initialization runs synchronously inside a Durable Object storage transaction before the public Durable Object runtime starts serving usage-control RPC operations.

For a fresh database, the adapter creates the v1 tables and indexes and then writes schema version `1`.

For a database created by the pre-versioning v0.1 implementation, the adapter validates the existing `budgets` and `reservations` column layout and accounting constraints before adopting it as schema v1. Existing accounting rows are not rewritten. Missing v1 indexes may be recreated because they do not change quota balances.

Initialization is safe to retry. If initialization throws, the schema transaction is rolled back and the Durable Object does not proceed with usage enforcement.

## Fail-closed cases

Startup fails rather than silently repairing or reinitializing when any of these conditions is detected:

- only one of the required accounting tables exists;
- required columns or accounting constraints differ from the expected v1 layout;
- schema metadata is malformed;
- the stored schema version is newer than the runtime supports;
- the stored schema version is older than the runtime supports and no explicit migration step is registered.

A remote caller then observes the usage-control backend as unavailable. Applications should preserve their existing fail-close policy and must not convert a schema incompatibility into an unmetered fallback path.

## Adding a future schema version

A schema-changing release must add an explicit deterministic migration step from the immediately previous version.

The migration should:

1. run inside the schema transaction;
2. preserve all quota/accounting invariants while transforming data;
3. be safe if startup is retried after an interrupted deployment;
4. validate the resulting tables, indexes, and constraints;
5. update `usage_control_schema.version` only after the migration succeeds;
6. include unit coverage for fresh creation, upgrade, retry/interruption, and unsupported versions;
7. run the Cloudflare workerd integration suite before merge.

Do not use `CREATE TABLE IF NOT EXISTS` as a substitute for a data/schema migration.

## Deployment procedure

Before deploying a schema-changing release broadly:

1. deploy it to a dedicated dogfood/test Worker and Durable Object domain;
2. exercise `reserve`, `markLiable`, `renew`, `settle`, expiry recovery, contention, and retry/reconciliation paths;
3. confirm no schema/startup errors are reported as business `quota_exceeded` results;
4. confirm the application remains fail-closed if the usage-control Worker cannot start;
5. expand deployment only after the migrated domain remains stable.

The normal deployed-E2E procedure is documented in [Cloudflare deployed E2E](cloudflare-deployed-e2e.md).

## Rollback limitations

For the initial versioning change itself, pre-versioning v0.1 accounting tables are adopted without data rewrites, so the change does not require a destructive conversion of existing balances.

Do **not** generalize that property to future versions. After a later schema migration changes columns, constraints, or stored semantics, an older binary may not understand the migrated database. Every schema-changing release must document whether binary rollback is supported and, when necessary, define a forward-fix or explicit data rollback procedure before deployment.

Never lower the stored schema version manually to force an old runtime to start.
