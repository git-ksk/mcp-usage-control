# Cloudflare SQLite schema migrations

`mcp-usage-control-cloudflare` versions the SQLite schema owned by each usage-control Durable Object transaction domain.

## Current schema

The current schema version is **3**.

Schema v3 contains `budgets`, `reservations`, v2 `reservation_growth`, v3 `reservation_vectors`, the active/tombstone expiry indexes, and the single-row `usage_control_schema` marker. The v1 `budgets` / `reservations` column layouts remain unchanged through v3.

## Startup and migration behavior

Initialization runs synchronously inside a Durable Object storage transaction before usage-control RPC operations are served. It is retry-safe; an exception rolls back the schema transaction and prevents enforcement from starting.

Supported paths are deterministic:

- fresh/pre-versioning: validate/adopt or create v1 -> add v2 `reservation_growth` -> add v3 `reservation_vectors` -> validate v3 -> write version 3;
- marked v1: validate -> v2 -> v3 -> validate -> version 3;
- marked v2: validate -> v3 -> validate -> version 3;
- v3: validate the exact supported layout;
- future version: fail closed.

Existing accounting rows are not rewritten by the additive migrations. Missing v1 indexes may be recreated because they do not alter balances.

## v1 -> v2 progressive-growth migration

v2 adds `reservation_growth` without changing v1 accounting tables. Existing reservations receive no growth row and remain fixed; new growth-capable reservations create the row atomically with admission. No quota balance, liability state, expiry, settlement, or tombstone is rewritten.

## v2 -> v3 vector-metadata migration

v3 adds only `reservation_vectors` (`reservation_id`, `dimensions_json`, optional `actual_dimensions_json`, optional `last_vector_growth_json`). It does not backfill scalar reservations or rewrite balances/lifecycle state, so existing v1/v2 rows remain scalar.

A new vector admission writes its normal base reservation identity plus the sidecar in the same `transactionSync` boundary. The sidecar stores per-dimension reserved totals; unlike units are never converted into scalar `reserved_units`. The base vector row uses scalar `reserved_units = 0` as a non-accounting placeholder.

A v2 binary does not understand schema version 3. After migration, rollback must use a forward fix or a separate/explicitly restored domain; never manually lower `usage_control_schema.version`.

## Fail-closed cases

Startup fails rather than silently reinitializing when required accounting tables are incomplete, columns/constraints differ, schema metadata is malformed, the stored version is newer than supported, or an old version has no deterministic registered migration. Applications must preserve fail-closed behavior and must not turn schema incompatibility into unmetered execution.

## Future schema changes

Every schema-changing release must add an explicit deterministic migration from the immediately previous version, run inside the schema transaction, preserve accounting invariants, be retry-safe, validate the resulting layout, update the version only after success, cover fresh/upgrade/interruption/future-version tests, and pass local workerd integration before merge.

`CREATE TABLE IF NOT EXISTS` is not a substitute for a declared migration step.

See [Cloudflare deployed E2E](cloudflare-deployed-e2e.md) for deployment evidence and rollback planning.
