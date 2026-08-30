# Operation reconciliation and status

[English](operation-reconciliation.md) | [日本語](operation-reconciliation.ja.md)

Status: **v0.13 contract; scalar and vector read-only reconciliation are adopted for the future v1 surface as optional Store capabilities.**

`mcp-usage-control` treats an ambiguous acknowledgement from a state-changing Store call as a correctness event. A caller must not create a second unrelated reservation merely because it does not know whether the first call committed.

v0.8 introduced the provider-neutral, **read-only** scalar operation-status vocabulary. v0.13 adds the parallel `VectorOperationReconciliationStore` contract for ambiguous initial vector-reserve acknowledgements without changing `UsageStore` or `VectorUsageStore`.

## Core types

```ts
import type {
  OperationReconciliationStore,
  UsageOperationReconciliation,
  UsageOperationReconciliationInput,
  VectorOperationReconciliationStore,
  VectorUsageOperationReconciliation,
  VectorUsageOperationReconciliationInput,
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

| Store | scalar reconciliation | vector initial-reserve reconciliation | Mechanism / boundary |
| --- | --- | --- | --- |
| `MemoryUsageStore` | **Supported** | **Supported** | `reconcileOperation()` / `reconcileVectorOperation()` read retained in-process state without running expiry recovery. Process restart loses Memory state, so `absent` after restart is not historical proof. |
| `RedisUsageStore` | **Supported** | **Supported** | Read-only Lua paths use Redis `TIME`, `HGET`, and `ZSCORE`; expected scalar/vector topology is validated before status is returned. |
| `FirestoreUsageStore` | **Supported** | **Supported** | Read-only Firestore transactions validate expected scalar/vector topology. The existing bounded/synchronized host-clock requirement still applies to expiry classification. |
| Cloudflare Durable Objects | **Supported** | **Not supported; fail closed** | `reconcileRemoteCloudflareOperation()` uses the authenticated read-only lookup gateway. Vector initial-reserve ACK ambiguity remains fail closed in v0.13. |

The base `UsageStore` does not require reconciliation, so third-party Stores remain source-compatible. A third-party Store that does not implement the optional capability must keep ambiguous acknowledgement handling fail closed and document its narrower recovery boundary.

## Vector reserve reconciliation (v0.13)

`VectorOperationReconciliationStore` mirrors the scalar read-only boundary for an ambiguous **initial vector reserve** acknowledgement. The caller supplies the exact trusted operation identity plus expected dimension keys, reserved units, and budget-key topology. A mismatch rejects/fails closed; limits remain current policy inputs and are not historical identity.

`MemoryUsageStore`, `RedisUsageStore`, and `FirestoreUsageStore` implement the vector capability. Scalar lookup rejects vector state and vector lookup rejects scalar state rather than coercing modes. Growth and settlement keep their existing exact replay fences.

Cloudflare Durable Objects remain an explicit v0.13 exception: the authenticated remote reconciliation subpath currently proves scalar initial-reserve status only. Cloudflare vector reserve ACK ambiguity therefore remains fail closed; callers must not infer vector support from scalar reconciliation or blindly replay a vector reserve. This exception must be removed or deliberately re-reviewed before any future claim of provider-wide vector reconciliation parity.

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
