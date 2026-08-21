# Firestore UsageStore

[English](firestore.md) | [日本語](firestore.ja.md)

`mcp-usage-control-firestore` is a `UsageStore` adapter backed by server-side Firestore transactions.

## Short version

Firestore is a good fit when:

- your application already runs on Firebase or GCP;
- most quotas are user-scoped and use different budget keys per user;
- you prefer not to operate another stateful service such as Redis.

Load-test carefully when:

- many calls share one strict tenant-wide quota;
- one system-wide global quota is updated by most requests;
- admission must run at very high frequency with very low latency.

The reason is simple: **the same budget key maps to the same Firestore document**. A heavily shared budget can therefore become the main transaction-contention point.

## Minimal setup

Pass Firebase Admin `getFirestore()` or the Google Cloud Node.js Firestore client directly:

```ts
import { getFirestore } from 'firebase-admin/firestore';
import { UsageControl } from 'mcp-usage-control';
import { FirestoreUsageStore } from 'mcp-usage-control-firestore';

const db = getFirestore();
const store = new FirestoreUsageStore(db);
const control = new UsageControl(store, policy);
```

This adapter is for **trusted server/Admin clients**. It is not designed to make a browser or mobile Firestore SDK the authoritative quota store.

The adapter does not depend on Firebase or Google Cloud SDKs at runtime. It accepts the application's existing server Firestore client through a structural interface.

## What is stored in Firestore?

The default layout uses two collections:

```text
muc_budgets/{sha256(budgetKey)}
muc_reservations/fs1.{sha256(operationScope)}
```

Change the `muc` prefix with `collectionPrefix`.

A budget document stores authoritative used/reserved capacity. A reservation document stores the lease state for one logical operation.

Raw principal IDs, tenant IDs, tool names, operation IDs, and budget keys are not stored in document bodies. Document IDs use SHA-256 digests.

Hashing is not encryption. Do not treat hashed document IDs as secrets.

## Most important concept: the budget key defines sharing

The Firestore adapter does not infer whether a budget is a user budget or tenant budget.

**If the application supplies the same `budget.key`, callers share the same budget document.**

The adapter does not infer reset dates or window expiry. A daily/monthly policy must encode the window in `budget.key`, and historical non-zero budget state must not be deleted by a generic retention rule that could reset a still-valid quota.

### Per-user example

```text
user:a:daily:2026-08-12 -> document A
user:b:daily:2026-08-12 -> document B
user:c:daily:2026-08-12 -> document C
```

Writes naturally spread across separate documents.

### Shared tenant example

```text
tenant:company-x:monthly:2026-08
```

If every user in company-x uses this key, every call updates the same budget document:

```text
user-a --\
user-b ----> shared tenant budget document
user-c --/
```

That is not an implementation accident. It is the **serialization point required by a strict shared quota**.

## Multiple budgets are enforced in one transaction

For a call that uses user-daily, user-monthly, and tenant-monthly budgets, the adapter processes the reservation document and every participating budget in one Firestore transaction:

```text
user daily ----\
user monthly ---+--> one Firestore transaction --> reservation
tenant monthly -/
```

If any budget is insufficient, no other budget is partially reserved.

Firestore retries transaction conflicts. If it cannot eventually complete the transaction, the call fails with a store error.

**Never turn a store failure into unmetered allow behavior.**

## What happens with a heavily shared budget?

Transactions that update the same document can contend with each other.

Firestore retries contention automatically, but sustained contention can eventually fail with an error such as:

```text
ABORTED: Too much contention on these documents
```

Firestore does not publish one universal guarantee such as "a single document is always safe up to X writes per second." Real behavior depends on transaction rate, participant count, network latency, index load, and workload shape.

Load-test realistic traffic when using shared tenant or global budgets.

Also compare Redis, Durable Objects, or an RDBMS when:

- many users continuously hit the same tenant budget;
- each invocation updates many budgets;
- admission requires very low latency at high frequency;
- one global budget becomes a system-wide hotspot.

Run the Firestore server client close to the database region. Higher latency increases transaction/retry cost.

## How are expired reservations recovered?

Do not rely on Firestore TTL to delete pending reservation documents by itself.

If only the reservation disappears, its capacity can remain reserved in budget documents.

Use the adapter's transactional recovery path instead:

```ts
const summary = await store.recoverExpired(100);
```

Expiry behavior is:

| State | On expiry |
| --- | --- |
| `pending` | release reserved units from budgets and delete the reservation |
| `liable` | retain the full reservation and conservatively settle it |
| settled tombstone | delete only the replay-protection document |

`reserve()` also performs a small bounded best-effort cleanup by default.

If production needs a predictable recovery delay, invoke `recoverExpired()` periodically from Cloud Scheduler, cron, or equivalent.

Set `cleanupBatchSize: 0` to disable automatic cleanup. In that mode, an external scheduler is recommended.

## Clock behavior

Firestore lease arithmetic uses the application host's `Date.now()`.

Unlike the Redis adapter, it does not use a datastore server clock such as Redis `TIME` as the lease authority.

The default `expiryGraceMs: 5000` adds a five-second grace period to reduce premature recovery caused by small clock skew.

For production:

- keep host clocks synchronized with NTP or equivalent;
- make TTLs comfortably larger than expected network latency and clock skew;
- compare Redis or Durable Objects when strict centralized lease-time authority is required.

## Firestore access per call

With `N` participating budgets, the rough access pattern is:

- reserve: read reservation + N budgets; on success write reservation + N budgets;
- `markLiable()`: update only the reservation;
- `renew()`: update only the reservation;
- settle: read the reservation and read/write budgets when unused capacity must be released;
- recovery: transactionally process the expired reservation and required budgets.

More budgets mean more Firestore operations and transaction participants. Estimate billing and latency from this write amplification, not only from tool-call count.

The normal `markLiable()` and `renew()` paths do not read shared budget documents, so heartbeat traffic does not create unnecessary tenant-budget contention.

## Security checklist

- use the adapter only from trusted server credentials;
- do not let clients write directly to budget or reservation collections;
- derive principal and tenant identity from trusted authentication context;
- never fall back to unmetered allow when Firestore is unavailable;
- distinguish business `quota_exceeded` from Firestore availability/contention errors;
- do not treat hashed IDs as secrets;
- avoid raw high-cardinality user/budget values as metric labels.

## Which store should I choose?

| Deployment | Good candidate |
| --- | --- |
| Firebase/GCP with mostly user-scoped quotas | **Firestore** |
| High-frequency tenant/shared quotas | Compare Redis |
| Cloudflare-centric deployment | Compare Durable Objects |
| Tests/local development | Memory |

Even when Firestore is a good fit, load-test production-like traffic if shared budgets are important.

## References

- Firestore transactions: https://firebase.google.com/docs/firestore/manage-data/transactions
- Transaction contention / serializable isolation: https://firebase.google.com/docs/firestore/transaction-data-contention
- Reads/writes at scale: https://firebase.google.com/docs/firestore/understand-reads-writes-scale

See [API reference](api-reference.md) for options and [Architecture](architecture.md) for the full state machine.

## Operation reconciliation (v0.8)

`FirestoreUsageStore` implements optional scalar `OperationReconciliationStore`. `reconcileOperation()` performs a read-only Firestore transaction against the deterministic hashed reservation document and validates expected reserved units/budget hashes. It never invokes cleanup or writes recovery state.

Expiry classification uses the existing `expiryGraceMs` / bounded host-clock contract. A terminal liable-expiry row that Firestore has already conservatively converted into a settled tombstone may be reported as `settled` because the schema intentionally does not retain separate historical expiry provenance; either result is terminal and never authorizes business replay. Firestore Emulator CI runs the portable reconciliation suite.

## Progressive reservation growth (v0.6)

`FirestoreUsageStore` implements the optional progressive-growth contract with one Firestore transaction covering the reservation document and every participating budget document.

The next growth cursor is generated **outside** the transaction callback. Firestore may retry that callback automatically; keeping the attempt identity/cursor fixed across those retries prevents an SDK retry from becoming a second logical increase. The transaction then enforces exact increment replay, stale-cursor rejection, exact original budget membership, all-or-nothing quota admission, and the existing pending/liable expiry rules.

Storage compatibility is additive: v0.6 reservation documents may contain `growthCursor` and latest-growth replay metadata. Existing v0.5 documents remain valid fixed reservations and are not implicitly upgraded into growable reservations. No collection reset or accounting rewrite is required.

The existing `expiryGraceMs` clock-skew contract also applies to growth. A reservation that is still inside the configured grace may grow; after authoritative expiry/recovery, every growth call fails closed. Tests cover grown pending release, liable retention, Firestore transaction retry behavior, and commit-after-ACK-loss replay with the same stable increment identity.

## Atomic heterogeneous vector usage (v0.7)

`FirestoreUsageStore` implements optional `VectorUsageStore` using additive optional reservation-document fields: `mode: "vector"`, dimension metadata, per-dimension actuals, and vector-growth replay metadata. Existing v0.6 mode-less documents remain scalar and require no rewrite.

Vector admission, growth, settlement, and expiry/recovery run in one Firestore transaction over the reservation plus every participating budget document. The next vector growth cursor is created outside the transaction callback so automatic Firestore retries cannot double-grow. Emulator CI runs portable vector conformance and committed-growth acknowledgement-loss replay.
