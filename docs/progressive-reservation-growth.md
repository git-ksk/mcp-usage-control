# Progressive reservation growth

Status: **v0.6 design contract; adoption is conditional on portable/provider proof.**

This document defines the candidate failure-safe contract for increasing the capacity of one live reservation without creating a second logical operation.

## Boundary

Progressive growth is an extension of the existing reservation lifecycle:

`quote -> reserve -> [grow]* -> mark liable -> [grow/renew]* -> settle`

`grow` changes reserved capacity only. It does **not** renew the lease, replay a business result, create a wallet, or create another logical operation.

The existing fixed-reservation model remains valid. Third-party `UsageStore` implementations are not required to implement growth.

## Public shape

The preferred public surface is:

- `UsageLease.grow(...)` as the application-facing helper;
- an optional `ProgressiveUsageStore` capability with a `growReservation(...)` primitive;
- additive growth metadata on reservations created by growth-capable Stores.

`renew` remains lease-duration-only and must not acquire capacity.

A growth attempt supplies:

- the existing `reservationId`;
- an application-stable `incrementId` identifying exactly one logical increase attempt;
- the Store-issued `growthCursor` currently attached to the lease;
- `additionalUnits`;
- the complete participating budget set, including current limits.

The budget key set must exactly match the reservation's original participating budget key set. Growth cannot add, remove, or substitute budgets.

## Growth cursor and lost acknowledgements

The growth cursor is an opaque replay fence. It is not an authorization credential.

A Store rotates the cursor on every **authoritatively completed** growth attempt:

- accepted capacity increase; or
- authoritative quota denial.

Provider/transport failure that does not establish an authoritative result must not be converted into success.

This yields the required lost-ACK behavior:

1. caller sends increment `I` with cursor `C0`;
2. Store atomically commits the result and records exact replay metadata, producing cursor `C1`;
3. the acknowledgement is lost;
4. the caller still has `C0`;
5. retrying `I` with the same parameters and `C0` returns the recorded result and `C1`;
6. sending an unrelated new increment with stale `C0` fails closed.

The caller must therefore preserve/reconstruct the same `incrementId` after ambiguity. Generating a fresh increment identity after an ambiguous result is invalid.

## Replay semantics

For the most recently completed attempt retained by the active reservation/tombstone:

- same `incrementId`, same prior cursor, and same canonical attempt parameters -> exact replay, no additional reservation;
- same `incrementId` with different units, limits, budget set, or cursor -> state conflict;
- different `incrementId` with a stale cursor -> state conflict;
- different `incrementId` with the current cursor -> a new authoritative attempt.

The canonical attempt fingerprint covers `additionalUnits` and the canonicalized `{ budgetKey, limit }` list. The Store-specific opaque next cursor is not part of the fingerprint.

## Atomic admission

For a new growth attempt, the Store transaction must:

1. prove the reservation is active;
2. prove the supplied cursor is current;
3. prove the supplied budget key set matches the reservation;
4. recover/reject expiry according to the existing pending/liable rules;
5. read authoritative usage for every participating budget;
6. decide whether `additionalUnits` fits every budget;
7. record the attempt result and rotate the cursor;
8. if accepted, increase every participating budget and `reservedUnits` in the same atomic transaction.

There is no partial growth. If any budget denies the increase, capacity is unchanged for every budget.

## Pending and liable semantics

Growth inherits the reservation's existing liability state.

- **pending + accepted growth:** the additional capacity is still pending. If the lease expires before `markLiable`, all reserved capacity, including growth, is released.
- **liable + accepted growth:** the additional capacity is immediately cost-liable because execution has already started. If the lease expires, the full grown reservation is conservatively retained/charged.
- `grow` does not change pending to liable and does not renew TTL.

A race between `grow` and `markLiable` is resolved by the Store transaction order. Either growth commits while pending and is subsequently made liable with the reservation, or `markLiable` commits first and the growth inherits liable state.

## Settlement

`reservedUnits` is the total successfully reserved capacity:

`initial reserved units + all successfully committed growth units`

Authoritative quota denials do not change `reservedUnits`.

Settlement must continue to reject:

`actualUnits > reservedUnits`

A successful settlement at exactly the grown total is valid.

## Races

### Concurrent same increment

Exactly one transaction evaluates the new attempt. Other contenders replay the same recorded result. Capacity increases at most once.

### Concurrent distinct increments

Only one contender can consume the current growth cursor. The other contender observes a stale cursor and fails closed. Callers that need multiple increases must serialize them through the returned cursor.

### Grow vs settle

- growth first: settlement observes the grown total;
- settlement first: every growth call, including replay of an earlier increment, is rejected.

The Store must not return a growth success after settlement. Retained replay metadata may support later reconciliation, but it must not authorize more metered work.

### Grow vs expiry/recovery

The same transaction/serialization boundary that protects reserve/settle must protect growth.

- growth before pending expiry: later recovery releases the grown total;
- growth before liable expiry: later recovery retains the grown total;
- expiry/recovery first: every growth call, including replay of an earlier increment, is rejected. A replay must never resurrect an expired lease.

## Provider ambiguity

A thrown Store/provider error is not a quota denial and not permission to continue metered work. The caller stops additional metered work and retries the **same increment identity** until the Store can prove an authoritative replay, or fails the operation closed.

Provider-specific status/reconciliation added in later releases may improve diagnosis, but v0.6 growth correctness must not depend on optimistic reconciliation.

## Storage compatibility

Growth metadata is additive and optional for reading existing data.

- v0.5 reservations/tombstones remain readable with their fixed-reservation semantics.
- reservations created before growth metadata exists are not implicitly upgraded into growable reservations.
- v0.6 growth-capable Stores write the cursor/replay fields needed for safe growth.
- cleanup/recovery keeps the replay metadata for as long as the corresponding reservation/tombstone is retained; it must never reuse stale metadata to grow a later reservation incarnation.

Provider-specific migrations must remain backward-compatible and must be applied before a Store advertises growth support.

## MCP usage pattern

The safe pattern is:

1. reserve a small bounded amount;
2. mark the lease liable immediately before metered work starts;
3. perform work only within the currently reserved capacity;
4. before crossing that capacity, request a bounded growth increment with a stable `incrementId`;
5. continue only after an authoritative accepted result;
6. on quota denial or unresolved ambiguity, start no additional metered work and stop/finalize safely;
7. settle actual usage against the total successfully reserved capacity.

Multi-round MCP/Tasks flows keep the same logical operation and reservation identity. A second reservation is not a top-up mechanism.

## v1 decision gate

The capability is adopted into the future v1 stable surface only if Memory, Redis, Cloudflare Durable Objects, and Firestore all pass portable proof plus provider-specific concurrency/ambiguity tests. Otherwise #83 is explicitly deferred/excluded from v1 and the fixed bounded-reservation model remains the v1 contract.
