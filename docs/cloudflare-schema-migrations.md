# Cloudflare SQLite schema migrations

`mcp-usage-control-cloudflare` versions the SQLite schema owned by each usage-control Durable Object transaction domain.

## Current schema

The current schema version is **2**.

Version 2 keeps the v1 accounting layout and adds one separate progressive-growth metadata table:

- `budgets`
- `reservations`
- `reservation_growth` (`reservation_id`, current `growth_cursor`, latest replay metadata)
- `reservations_active_expiry`
- `reservations_tombstone_expiry`
- `usage_control_schema`, a single-row metadata table containing the schema version

The v1 `budgets` and `reservations` column layouts are unchanged.

The schema metadata is internal adapter state. Do not modify it from application code.

## Startup behavior

Schema initialization runs synchronously inside a Durable Object storage transaction before the public Durable Object runtime starts serving usage-control RPC operations.

For a fresh database, the adapter creates the v1 accounting tables/indexes, adds `reservation_growth`, validates the resulting v2 layout, and then writes schema version `2`.

For a pre-versioning database, the adapter first validates/adopts the exact v1 accounting layout and then performs the deterministic v1 -> v2 additive migration. For an explicitly marked v1 database, it validates v1 before the same migration. Existing `budgets` / `reservations` accounting rows are not rewritten; only `reservation_growth` and the schema-version marker are added. Missing v1 indexes may still be recreated because they do not change quota balances.

Initialization is safe to retry. If initialization throws, the schema transaction is rolled back and the Durable Object does not proceed with usage enforcement.

## v1 -> v2 progressive-growth migration

The v0.6 migration is intentionally additive. It creates `reservation_growth` without changing the v1 accounting tables. Reservations that already exist at upgrade time have no corresponding growth row and therefore remain fixed reservations. New v0.6 reservations create their growth row atomically with admission and can opt into `grow`.

This avoids retroactively inventing a growth cursor for an operation whose caller never received one. No quota balance, liability state, expiry timestamp, settlement state, or tombstone is rewritten by the migration.

An older v1 binary does not understand schema version 2 and must not be used after a domain has migrated. Rollback is therefore a forward-fix/new-domain operation rather than manually lowering `usage_control_schema.version`.

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
