# Memory store operations

`MemoryUsageStore` is a process-local reference implementation for tests, development, and controlled single-process deployments. It is not durable across process loss and is not a replacement for Redis, Cloudflare Durable Objects, or Firestore when enforcement state must survive restarts or be shared across instances.

## Long-running process behavior

The store retains three kinds of in-process state:

- active reservations;
- settled-operation tombstones used for replay protection;
- non-zero usage totals for budget keys.

Active reservations are recovered when their lease expires. Settled operation tombstones are retained for `idempotencyTtlMs` (24 hours by default) and then removed. Expiry scanning is scheduled around the earliest known reservation/tombstone deadline instead of scanning every retained reservation on every store call.

Budget usage is different: deleting a non-zero budget key can silently reset quota. The store therefore never guesses that a budget is safe to forget and never uses LRU eviction for authoritative usage state.

## Bounded retention and fail-closed capacity

To prevent unbounded memory growth, `MemoryUsageStore` applies default retention caps:

- `maxRetainedOperations`: 100,000 active reservations plus settled replay tombstones;
- `maxRetainedBudgetKeys`: 100,000 distinct budget keys with non-zero retained usage.

Both are configurable in `MemoryUsageStoreOptions`.

When a cap would be exceeded, the store throws `MemoryUsageStoreCapacityError`. It does **not** evict accounting state to make room. This is intentionally fail-closed: memory pressure must not turn into a quota reset or loss of replay protection.

```ts
const store = new MemoryUsageStore({
  idempotencyTtlMs: 60 * 60 * 1000,
  maxRetainedOperations: 50_000,
  maxRetainedBudgetKeys: 20_000,
});
```

Choose `maxRetainedOperations` from the expected logical-operation rate multiplied by the replay-protection retention horizon, with headroom for active work. Lower `idempotencyTtlMs` only when the application can prove that its retry/replay horizon is shorter.

`stats()` exposes current retained operation and budget-key counts together with their configured limits for health checks and operational monitoring.

## Retiring time-window budget keys

Time-window policies often encode the window in the key, for example:

```text
day:user:42:2026-08-13
day:user:42:2026-08-14
month:tenant:7:2026-08
```

A generic store cannot infer when an old key is permanently outside the policy's accounting horizon. For controlled single-process deployments, the application may explicitly retire an old completed key:

```ts
store.retireBudgetKey('day:user:42:2026-08-13');
```

`retireBudgetKey()` refuses to remove a key that is still referenced by an active reservation. The caller must also guarantee that the key will not later be reused for the same accounting window. Retiring a live or reusable budget would intentionally reset its in-memory usage and is therefore an application-level lifecycle decision, not automatic garbage collection.

Zero-unit reservations do not create retained budget-key entries.

## Production guidance

Use a shared/durable store when any of the following apply:

- accounting state must survive process restart;
- more than one application instance can enforce the same budget;
- the set of historical budget keys is large or unbounded;
- operational capacity must remain available without application-managed budget retirement;
- persistence/HA requirements exceed a process-local reference store.

The retention caps are a safety guardrail, not a durability feature. Hitting a cap should be treated as an operational signal to retire completed windows where semantically valid, tune retention deliberately, or move the workload to a production store.
