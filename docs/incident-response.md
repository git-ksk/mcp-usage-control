# Known-bad release containment and emergency hotfix runbook

[English](incident-response.md) | [日本語](incident-response.ja.md)

This runbook applies when a released version may violate usage-enforcement, replay, settlement, authentication, or persisted-state safety. It consumes the compatibility contract in [Persisted-state compatibility and rollback](persisted-state-compatibility.md); it does not redefine provider schema semantics.

## First rule: contain before changing authoritative state

When impact is uncertain, stop or gate **new cost-bearing dispatch** before attempting a data repair. Do not clear counters, rotate accounting-domain selectors, or fall back to an unmetered path merely to restore availability.

Record at minimum:

- affected package/version and exact commit/tag;
- affected provider(s) and accounting-domain selector;
- observed invariant at risk: bypass/double-spend, conservative overcharge, incompatible/corrupt state, remote authentication, or release-distribution defect;
- whether newer schema/state may already have been written;
- known safe target version and its persisted-state compatibility;
- containment action and timestamp.

Security-sensitive defects use GitHub private vulnerability reporting before public exploit detail.

## Severity and immediate containment

| Scenario | Initial severity | Immediate action |
| --- | --- | --- |
| quota bypass / double-spend / unauthenticated remote Store access | Critical | block new cost-bearing dispatch or affected route; preserve authoritative state; start security process |
| corrupted/incompatible persisted state | Critical/High | stop writes to the affected accounting domain; snapshot/backup before repair |
| conservative overcharge / retained-capacity defect | High | stop or narrow affected work if material; never "refund" by deleting authoritative state without proof |
| known-bad source/package artifact with no confirmed runtime impact | High/Medium | mark release as affected/superseded; stop recommending/installing it; prepare fixed release |

## Rollback decision

Use this order:

1. **Can the candidate older runtime read every persisted shape already written?**
   - Yes: rollback may be considered.
   - No/unknown: do **not** downgrade against the live domain.
2. **Can a provider-native snapshot from before incompatible writes be restored as one complete authoritative domain?**
   - Yes: restore only under an explicit outage/cutover plan that prevents concurrent writes to old and restored copies.
   - No: roll forward with a compatible hotfix.
3. Never edit `schemaVersion`, SQL migration markers, Redis JSON, Firestore documents, or domain selectors merely to make an older binary start.

Provider notes:

- **Redis:** rollback is conditional even when `schemaVersion: 1` is present. Older code must understand every scalar/vector/growth/replay field already written. Otherwise roll forward or restore a compatible complete Redis snapshot/domain.
- **Firestore:** reservation and budget collections form one accounting domain. Do not restore/copy only one side. A target runtime must understand every current document shape.
- **Cloudflare Durable Objects:** after a domain reaches SQLite schema v3, a runtime whose maximum schema is lower than v3 is not a valid rollback target. Never lower `usage_control_schema.version`; roll forward or restore a compatible domain snapshot.

## Emergency patch release gate

Speed does not remove the accounting evidence floor. Before promoting a hotfix:

- reproduce or otherwise characterize the defect with sanitized evidence;
- add a regression test for the affected invariant where technically possible;
- run the complete Node/Redis/package matrix;
- run Cloudflare workerd and/or Firestore Emulator evidence whenever the affected path can touch those providers;
- verify package contents and clean-consumer imports;
- verify persisted-state compatibility for the affected provider;
- document affected versions, impact, mitigation, safe target version, and rollback/schema warning.

A maintainer may reduce unrelated exploratory work during an incident, but must not skip the release-critical invariant tests that cover the defect class.

## GitHub/source release containment

For a known-bad GitHub/source release:

1. preserve the tag/release as audit evidence unless GitHub security guidance requires otherwise;
2. edit the release title/body to state **KNOWN BAD / SUPERSEDED** and link the advisory/fixed version;
3. do not silently replace existing release assets with rebuilt bytes;
4. publish a fixed patch release from a separately tested commit;
5. update support/release notes with the safe target version.

## npm containment after #6 is authorized

Once npm publication exists, prefer npm deprecation/advisory guidance over destructive unpublish behavior. Publish a fixed version, deprecate the affected version with a concise safe-target message when appropriate, and verify a clean install resolves to the intended version. Registry publication remains separately authorized from source releases.

## Tabletop drill checklist

Run these checks before v1 and after material persisted-schema changes.

### Redis

- identify `prefix` / `hashTag` for the test domain;
- create scalar + vector/progressive retained state;
- assume the current release is known-bad;
- prove the selected rollback target can read every shape, or choose roll-forward;
- verify no domain-selector change creates accidental fresh quota.

### Firestore

- identify `collectionPrefix` and snapshot both reservation/budget collections together;
- create active and settled state in the Emulator;
- evaluate rollback compatibility against the exact document shapes;
- prove an incompatible target fails closed rather than treating documents as absent;
- restore/cut over only as one authoritative domain.

### Cloudflare

- initialize/migrate a workerd Durable Object test domain to the current schema;
- evaluate a hypothetical older runtime whose max schema is lower;
- verify the correct decision is roll-forward or compatible snapshot restore, never schema-marker downgrade;
- keep the Durable Object/accounting identity unchanged during a normal hotfix.

## Communication template fields

Every public incident/advisory should answer:

- affected versions/providers;
- user-visible and accounting/security impact;
- whether authoritative state may be affected;
- immediate mitigation;
- safe fixed version;
- rollback compatibility warning;
- whether credentials/domain identity must change;
- whether further reconciliation is required.
