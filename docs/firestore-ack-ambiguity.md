# Firestore ambiguous acknowledgement semantics

[English](firestore-ack-ambiguity.md) | [日本語](firestore-ack-ambiguity.ja.md)

`FirestoreUsageStore` uses Firestore transactions for authoritative state changes. A client-visible error does not always prove that a transaction did not commit: the write may have committed durably and the acknowledgement may have been lost afterwards.

This document defines the supported safety boundary for that ambiguity. The adapter does **not** turn an ambiguous state-changing result into an unmetered allow, and it does not create a second reservation automatically.

## Reserve

If `reserve()` returns or throws an ambiguous transport/client error after Firestore may have committed, the caller must treat the admission result as unknown and fail closed.

Retry the **same logical operation identity** only for reconciliation. If the original reservation committed, the retry is expected to return `duplicate_operation`. That result proves only that the operation identity is already represented in authoritative usage state; it is not a new admission result and must not be used to start metered business work.

Do not generate a new `operationId` merely to escape the duplicate result. Doing so would create a distinct accounting operation and could double-reserve capacity.

`FirestoreUsageStore` implements scalar `OperationReconciliationStore` and v0.13 `VectorOperationReconciliationStore`. If the initial reserve acknowledgement is ambiguous, use the same trusted logical operation identity plus the expected units / budget topology for read-only reconciliation against authoritative retained state. Reconciliation does not create a second reservation and does not authorize replay of the business operation. If the Store cannot prove a matching state, treat the result as indeterminate and fail closed.

## `markLiable()`

The caller already has a reservation ID from a previously confirmed admission. If the acknowledgement for `markLiable()` is ambiguous, retry `markLiable()` for the same reservation while it is still active.

The transition is safety-idempotent: repeating it does not create another reservation or another charge. If the retry cannot establish an active reservation, do not begin metered work based on an assumption that the first call committed.

A committed liability transition remains conservative: once execution may have started, expiry recovery retains the reserved amount rather than refunding it optimistically.

## `renew()`

A lost acknowledgement after `renew()` may mean that the longer lease already committed. Retrying `renew()` for the same reservation is safe. A later retry can extend the lease farther than the first attempt would have, which is conservative for quota enforcement and does not allocate additional usage units.

If renewal cannot be confirmed while work continues, the application must stop or otherwise fail closed according to its execution policy. It must not assume an unknown lease extension succeeded.

## `settle()`

Settlement reconciliation uses the existing idempotent terminal replay rule.

After an ambiguous settlement acknowledgement, retry with the exact same `reservationId`, `actualUnits`, and `outcome`. While the settlement tombstone is retained, an identical replay returns the same settlement result. A conflicting replay is rejected.

Do not change actual usage or outcome merely to obtain a successful response, and do not replay the underlying business operation. Business-result recovery remains outside `UsageStore`.

## Caller matrix

| Ambiguous operation | Supported recovery | Safety boundary |
| --- | --- | --- |
| `reserve()` | Retry the same logical identity; expect fail-closed `duplicate_operation` if the first commit landed | No automatic resume or second reservation; do not execute metered work from a duplicate result |
| `markLiable()` | Retry the same reservation while active | Do not start metered work until the liability transition is confirmed |
| `renew()` | Retry the same reservation | A later/larger expiry is conservative; unknown renewal must not be assumed successful |
| `settle()` | Replay the exact same terminal settlement | Only identical replay is accepted; conflicts fail closed |

## What the tests prove

The Firestore package includes fault-injection coverage where a transaction commits to the backing test database and the caller receives an error immediately after commit. The tests cover reserve, liability, renewal, and settlement and verify that:

- a committed reserve is not duplicated and continues to consume capacity;
- liability can be safely retried on the same reservation;
- a committed renewal remains effective after the acknowledgement is lost;
- identical settlement replay reconciles a committed settlement, while conflicting replay is rejected.

These tests are evidence for the adapter's acknowledgement-ambiguity contract. They do not claim that arbitrary business side effects are replayable or that every Firestore/network failure is distinguishable from a lost acknowledgement.
