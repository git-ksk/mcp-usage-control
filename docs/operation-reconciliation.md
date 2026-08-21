# Operation reconciliation and status

[English](operation-reconciliation.md) | [日本語](operation-reconciliation.ja.md)

Status: **v0.8 contract; adopted for the future v1 surface as an optional scalar Store capability.**

`mcp-usage-control` treats an ambiguous acknowledgement from a state-changing Store call as a correctness event. A caller must not create a second unrelated reservation merely because it does not know whether the first call committed.

v0.8 adds a small provider-neutral, **read-only** scalar operation-status vocabulary. The base `UsageStore` remains source-compatible; Stores opt in through `OperationReconciliationStore` or an adapter-specific equivalent such as the Cloudflare remote reconciliation helper.

## Core types

```ts
import type {
  OperationReconciliationStore,
  UsageOperationReconciliation,
  UsageOperationReconciliationInput,
} from 'mcp-usage-control';
```

`UsageOperationReconciliationInput` contains the exact trusted logical operation identity plus the scalar reserved units and budget identities expected for the retained reservation. Implementations fail closed when those values do not match authoritative retained state. Budget **limits are not historical identity**: mutable-limit policy changes remain governed by the existing same-key limit contract, so reconciliation compares budget keys rather than requiring an old limit value.

The result vocabulary is:

| Result | Meaning | Safe application action |
| --- | --- | --- |
| `absent` | No retained state is visible **now** | Do not automatically replay. Once the Store retention horizon may have elapsed, absence does not prove that no reservation ever existed. |
| `active / pending` | A matching reservation exists and liability has not been marked | Reattach only if the application separately proves that business work did not start and the trusted lease binding is still valid. Reconciliation itself is not replay authorization. |
| `active / liable` | A matching cost-liable reservation exists | Never replay the business side effect. Application-specific recovery may renew/settle the existing work. |
| `expired / pending` | The retained pending lease deadline passed | Do not start metered work from this result. Normal Store recovery may release capacity later. |
| `expired / liable` | The retained liable lease deadline passed or was conservatively recovered as liable-expired | Do not replay. Capacity remains conservative according to the Store contract. |
| `settled` | A matching terminal settlement/tombstone is retained | Terminal. No execution replay is authorized. |

### Indeterminate / unknown

`indeterminate` is intentionally **not** a successful status variant. If a backend/transport failure, unsupported mode, corrupt state, or binding mismatch prevents the Store from proving one of the statuses above, reconciliation rejects/throws and the caller must classify the operation as **indeterminate and fail closed**.

This avoids turning an infrastructure failure into an `absent` result or an accidental allow path.

## Read-only invariant

A reconciliation operation must not:

- reserve new capacity;
- release pending capacity;
- mark liability;
- renew a lease;
- settle usage;
- create or rewrite replay state.

Repeated reconciliation of the same retained state must not change accounting state. Normal lifecycle methods and normal Store cleanup/recovery remain the only writers.

## Reattachment boundary

An `active / pending` result can provide the authoritative reservation record needed by `UsageControl.resumeLease()`, but the application must also retain or reconstruct a trusted `ttlMs` and must independently know that the business side effect did not start through another path.

An `active / liable` result proves that usage accounting considers execution potentially started. It may support application-specific recovery of already-started work, but it is never permission to execute the business operation again.

Operation IDs and reservation IDs are correlation/replay identities, **not credentials or authorization artifacts**.

## Built-in Store support

| Store | v0.8 scalar reconciliation | Mechanism / boundary |
| --- | --- | --- |
| `MemoryUsageStore` | **Supported** | `reconcileOperation()` reads retained in-process state without running expiry recovery. Process restart loses Memory state, so `absent` after restart is not historical proof. |
| `RedisUsageStore` | **Supported** | `reconcileOperation()` uses a read-only Lua path (`TIME`, `HGET`, `ZSCORE`) and validates expected units/budget hashes. Redis integration runs the portable reconciliation contract. |
| `FirestoreUsageStore` | **Supported** | `reconcileOperation()` uses a read-only Firestore transaction and validates expected units/budget hashes. The existing bounded/synchronized host-clock requirement still applies to expiry classification. Firestore Emulator runs the portable reconciliation contract. |
| Cloudflare Durable Objects | **Supported through the reconciliation subpath** | `reconcileRemoteCloudflareOperation()` uses the authenticated read-only lookup gateway. `reconcileRemoteCloudflareReserve()` remains as the v0.7-compatible alias. Existing deployed/local lost-ACK reconciliation evidence remains applicable. |

The base `UsageStore` does not require reconciliation, so third-party Stores remain source-compatible. A third-party Store that does not implement the optional capability must keep ambiguous acknowledgement handling fail closed and document its narrower recovery boundary.

## Scalar-only v0.8 boundary

The v0.8 capability is intentionally **scalar-only**. `VectorUsageStore` remains an optional v0.7 capability, but v0.8 does not claim generic vector operation reconciliation. A scalar reconciliation API must reject a retained vector reservation rather than reinterpret it.

Vector growth and settlement already have their own exact retry/replay fences. Ambiguous initial vector-reserve acknowledgement remains fail closed unless a provider exposes a separately proven vector reconciliation mechanism in a future release.

## Portable conformance

Stores that implement `OperationReconciliationStore` can run:

```ts
import {
  assertOperationReconciliationStoreConformance,
  runOperationReconciliationStoreConformance,
} from 'mcp-usage-control/conformance';
```

The portable suite checks retained `absent -> pending -> liable -> settled` status, read-only expired-pending observation, and fail-closed quote-shape mismatch. Provider-specific durability, transport ambiguity, clock, and failover evidence is still required in addition to portable conformance.

## Non-goals

Operation reconciliation is not:

- a business-result cache;
- workflow replay;
- payment/billing ledger lookup;
- authorization;
- automatic retry middleware;
- a replacement for Store-specific settlement/growth idempotency.

The usage Store proves only usage-enforcement state. The application remains responsible for business-side idempotency and recovery.
