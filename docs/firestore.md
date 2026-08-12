# Firestore UsageStore

[English](firestore.md) | [日本語](firestore.ja.md)

`mcp-usage-control/firestore` implements the `UsageStore` contract with server-side Firestore transactions.

You can pass Firebase Admin `getFirestore()` or the Google Cloud Node.js Firestore client directly through a structural type. The core package does not add a runtime dependency on either Firebase or Google Cloud SDKs.

```ts
import { getFirestore } from 'firebase-admin/firestore';
import { UsageControl } from 'mcp-usage-control';
import { FirestoreUsageStore } from 'mcp-usage-control/firestore';

const db = getFirestore();
const store = new FirestoreUsageStore(db);
const control = new UsageControl(store, policy);
```

This adapter targets **Node.js server/Admin clients**. It is not designed to make a browser/mobile Firestore SDK the authoritative quota-enforcement store.

## Atomicity

For an invocation with multiple budgets, the adapter reads the reservation document and every budget document in one Firestore transaction, then performs the quota comparison and reservation as one all-or-nothing commit.

```text
user daily ----\
user monthly ---+--> one Firestore transaction --> reservation
tenant monthly -/
```

If any participating budget is insufficient, no other budget is partially reserved.

Firestore retries transactions affected by concurrent modifications. The complete transaction either commits or fails. Never convert a Firestore/store failure into unmetered allow behavior.

## Document layout

The default layout uses two top-level collections:

```text
muc_budgets/{sha256(budgetKey)}
muc_reservations/fs1.{sha256(operationScope)}
```

Change the `muc` portion with `collectionPrefix`.

Raw principal IDs, tenant IDs, tool names, operation IDs, and budget keys are not stored in document bodies. Document IDs use SHA-256 digests. Hashing reduces accidental identifier exposure but is not encryption and does not prevent dictionary attacks against predictable identifiers.

## Important: shared-budget contention / hotspots

Normal per-user budgets naturally distribute across separate documents:

```text
user-a daily -> budget doc A
user-b daily -> budget doc B
user-c daily -> budget doc C
```

This pattern scales writes across documents as the user population grows.

A tenant- or organization-wide shared budget is different: every user in that tenant updates the same document.

```text
user-a --\
user-b ----> tenant:company-x:monthly
user-c --/
```

That document is an **intentional serialization point**. Transactions using the same tenant budget contend on the same document because strict shared quota requires a common authoritative value.

Firestore automatically retries transaction contention, but sustained contention can eventually fail with `ABORTED: Too much contention on these documents`. Firestore does not provide a universal fixed guarantee such as "one document is always safe up to X writes/second". Load-test the real workload, including document write rate, transaction participants, index fanout, and network latency.

Compare Redis, Durable Objects, or an RDBMS when:

- many users continuously concentrate tool calls into one tenant budget;
- each invocation updates many budget documents;
- admission requires very high frequency and very low latency;
- a shared global budget becomes a system-wide hotspot.

Run the Firestore server client close to the database region. Higher network latency lengthens transaction lock/retry paths and can amplify contention.

References:

- Firestore transactions: https://firebase.google.com/docs/firestore/manage-data/transactions
- Transaction contention / serializable isolation: https://firebase.google.com/docs/firestore/transaction-data-contention
- Reads/writes at scale: https://firebase.google.com/docs/firestore/understand-reads-writes-scale

## Expiry recovery

Because Firestore stores budget counters and reservations in separate documents, do not use a Firestore TTL policy to delete pending reservation documents by itself. Deleting only the reservation would leave its reserved capacity in the budget counters.

The adapter keeps `expiresAtMs` queryable in the reservation collection and performs bounded recovery:

```ts
const summary = await store.recoverExpired(100);
```

Recovery follows the core semantics:

- pending expiry: release reserved units from every budget, then delete the reservation;
- liable expiry: retain the full reserved units and conservatively settle the reservation;
- settled tombstone expiry: delete only the replay-protection document; finalized usage remains in the budget.

By default, `reserve()` attempts a best-effort cleanup of at most 16 rows, throttled to at most once every five seconds per process. If that cleanup query fails, the failure can only leave stale capacity reserved; it cannot create extra quota capacity, so the authoritative reserve transaction still runs.

For production systems that need a bounded recovery delay, invoke `recoverExpired()` periodically from Cloud Scheduler, cron, or equivalent. `cleanupBatchSize: 0` disables automatic cleanup; an external scheduler is recommended in that mode.

## Clock semantics

The Redis adapter uses Redis server `TIME` as the authoritative lease/tombstone clock.

The Firestore transaction callback does not expose server commit time in a form this structural adapter can use for lease arithmetic, so the Firestore adapter uses the application host's `Date.now()` by default. Multiple application instances therefore need synchronized clocks.

The default `expiryGraceMs: 5000` delays recovery by five seconds to reduce premature recovery from small clock skew. This is not equivalent to an authoritative server-time guarantee.

For production:

- synchronize host clocks with NTP or equivalent;
- make lease TTLs comfortably larger than expected network latency and clock skew;
- compare Redis server time or a Durable Object when strict centralized lease-time authority is required.

## Cost / write amplification

With `N` participating budgets, the rough document-access shape is:

- reserve: read reservation + N budgets; on acceptance write reservation + N budgets;
- markLiable: transactional reservation update;
- renew: transactional reservation update;
- settle: read reservation + N budgets, release unused capacity when needed, then settle the reservation;
- recovery: transactionally process the expired reservation and its participating budgets.

Adding user daily + user monthly + tenant monthly budgets therefore increases transaction participants per invocation. Estimate Firestore billing and latency from this write amplification, not only from tool-call count.

## Security / operations

- allow only trusted server credentials to update enforcement collections;
- do not grant clients direct write access to budget/reservation collections;
- do not fall back to allow when Firestore/Admin credentials or the database are unavailable;
- distinguish business `quota_exceeded` from Firestore availability/contention failures;
- do not treat hashed document IDs as secrets;
- do not put raw high-cardinality identity/budget values into metric labels.

Firestore is a practical serverless option for small-to-medium MCP backends, especially when **per-user budgets dominate**. If large shared tenant/global budgets dominate, load-test the shared-document hotspot explicitly.
