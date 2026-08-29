# Persisted-state compatibility and rollback

`mcp-usage-control` treats provider state as enforcement-authoritative. Package SemVer is not permission to reinterpret, discard, or silently recreate accounting state.

This document freezes the built-in provider compatibility boundary for v0.11 -> v1.

## Rules shared by every durable provider

1. Unknown, newer, malformed, or structurally incompatible authoritative state must fail closed. It must never become an empty quota domain.
2. An upgrade may transform state only through a deterministic, tested path that preserves reservation, liability, settlement, replay, and budget invariants.
3. A rollback is supported only when the older binary is known to understand every persisted shape that the newer binary may have written.
4. Changing the provider namespace/domain selector intentionally selects different accounting state. That is an accounting reset, not a migration.
5. Backup/restore must preserve one authoritative domain. Do not run two independently writable copies and later merge them as if they were one ledger.

## Compatibility matrix

| Provider | v0.11/v1 persisted generation | Latest pre-v1 -> v1 | Newer state seen by v1 | Rollback boundary |
| --- | --- | --- | --- | --- |
| Redis | reservation JSON `schemaVersion: 1`; exact pre-v1 unversioned records remain supported | in-place; no bulk rewrite | fail closed before targeted mutation or cleanup mutation | conditional: only to a runtime known to understand all record fields present in the domain |
| Firestore | reservation and budget documents `schemaVersion: 1` | in-place; no collection rewrite | fail closed on unsupported document version | conditional: only while the target runtime supports every v1 document shape already written |
| Cloudflare DO SQLite | `usage_control_schema.version = 3` | in-place when already at v3; registered migrations handle older supported schemas | startup fails closed on a future version | rollback to a runtime whose max schema is lower than the stored version is unsupported |

## Redis

### v1 record generation

New scalar and vector reservation records carry numeric `schemaVersion: 1`.

The exact pre-v1 Redis record shape had no schema marker. v1 deliberately treats an absent marker as the supported legacy generation so existing reservations, liability state, growth metadata, vector metadata, settlements, and replay tombstones remain usable without a bulk migration.

There is no background or startup rewrite. A pre-v1 record may remain unversioned for its whole lifetime. This avoids a migration pass becoming a second accounting transition.

### Future-version fail-closed behavior

Any reservation with a present schema version other than `1` is unsupported by the v1 Redis scripts.

Targeted lifecycle operations reject it before changing the reservation or budget state. Reserve-time lazy cleanup preflights every reservation/tombstone record in the selected cleanup batch before performing any release, retention, deletion, or budget mutation. This preflight is required because Redis Lua runtime errors do not roll back writes already executed by the script.

A duplicate-operation mapping that still references an unsupported active record remains conservative: admission stays blocked rather than creating a second reservation.

### Rollback

The new `schemaVersion: 1` field is additive relative to the latest pre-v1 JSON shape, but this does **not** make arbitrary downgrade safe. Older releases may predate progressive growth, vector records, reconciliation metadata, or other persisted fields.

Rollback is supported only when the selected older release is explicitly known to understand all record modes and lifecycle metadata already present in that Redis domain. Otherwise restore a compatible backup or roll forward.

Never remove/change `schemaVersion` to force an older binary to accept state it does not understand.

### Domain reset boundary

`prefix` and `hashTag` select the Redis accounting domain. Changing either points the runtime at different keys and therefore resets visible quota/reservation/replay history for that runtime. Treat this as an explicit operator-driven reset/rekey, not a normal deployment change.

## Firestore

Firestore budget and reservation documents use `schemaVersion: 1`. Readers reject another version rather than treating the document as absent or zero-used.

The v0.11 -> v1 path does not rewrite collections or documents. Current scalar/vector lifecycle data remains inside the v1 document contract.

Rollback is conditional: the target runtime must understand every document mode and optional lifecycle field already written. `schemaVersion: 1` is a persisted generation marker, not proof that every historical binary supports every field added during that generation.

`collectionPrefix` selects the authoritative collection pair. Changing it selects fresh accounting state and is therefore a quota/replay reset unless the application performs a separately designed, offline, invariant-preserving migration.

Do not copy only reservations or only budgets. They form one accounting domain.

## Cloudflare Durable Objects SQLite

Cloudflare owns an explicit SQL schema marker and deterministic migrations. Current schema v3 contains the v1 base accounting tables plus progressive-growth and vector sidecars.

Initialization validates the current layout and performs registered forward migrations in one `transactionSync` boundary. A future schema version, malformed metadata, or incompatible table shape stops startup rather than serving unmetered traffic.

A binary whose maximum supported schema is lower than the stored schema must not be used as a rollback target. In particular, after a domain is migrated to v3, manually lowering `usage_control_schema.version` is forbidden. Roll forward or restore an explicitly compatible domain snapshot.

Changing the Durable Object class/namespace/binding so requests reach a fresh storage domain is an accounting reset even when application configuration otherwise looks equivalent.

See [Cloudflare SQLite schema migrations](cloudflare-schema-migrations.md) for migration details.

## Upgrade procedure

For a normal v0.11/v1 deployment:

1. identify the exact provider domain selectors (`prefix`/`hashTag`, `collectionPrefix`, or Durable Object namespace/class binding);
2. verify the target release supports the currently stored generation;
3. preserve a provider-native backup/snapshot when rollback requirements justify it;
4. deploy without changing domain selectors;
5. run the provider integration/health evidence required by the release policy;
6. if the runtime reports unsupported persisted state, stop billable dispatch and resolve the compatibility problem. Do not clear or recreate authoritative state as an automatic recovery action.

Backups and diagnostics should follow the normal privacy boundary: do not add raw prompts, tool arguments, credentials, or user PII merely to make migration evidence easier to inspect.

## Future schema changes

A future persisted generation must define before merge:

- the old -> new upgrade path;
- whether old binaries may safely read new writes;
- interruption/retry behavior;
- future-version fail-closed evidence;
- rollback or explicit no-rollback policy;
- fresh-domain/reset implications;
- provider integration tests covering the transformation.

If those answers are not known, the schema change is not release-ready.
