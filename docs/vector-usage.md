# Atomic heterogeneous usage vectors

Status: **v0.7 contract; adopted for the future v1 surface as an optional Store capability.**

v0.7 adds a typed vector accounting path for one logical operation that consumes unlike units such as requests, model tokens, compute seconds, or provider work units. The scalar `UsageControl` / `UsageStore` contract remains unchanged.

## Why a separate vector surface

A reservation such as:

```text
requests = 1
tokens   = 800
```

must not be represented as `801 units`. Those values have different dimensions, limits, settlement values, and policy meaning. v0.7 therefore adds a separate vector surface instead of widening scalar return types or summing unlike units.

The main application-facing types are:

- `VectorUsagePolicy`
- `VectorUsageControl`
- `VectorUsageLease`
- optional `VectorUsageStore`

A policy returns ordered/canonicalized dimensions:

```ts
{
  decision: 'allow',
  dimensions: [
    {
      key: 'requests',
      units: 1,
      budgets: [{ key: 'user:requests:day', limit: 100 }],
    },
    {
      key: 'tokens',
      units: 800,
      budgets: [{ key: 'user:tokens:day', limit: 100_000 }],
    },
  ],
}
```

Each dimension may participate in several hierarchical budgets. One budget key may not appear in multiple dimensions of the same vector reservation.

## Admission invariant

All dimensions required by one logical operation commit in one authoritative Store transaction or none commit.

Independent calls such as “reserve requests, then reserve tokens” are not equivalent: the first call could commit while the second is denied or ambiguous. `reserveVector()` closes that partial-commit gap.

Scalar and vector reservations also share the same logical-operation replay domain. The same operation identity cannot be admitted once through scalar accounting and again through vector accounting.

## Lifecycle

A vector reservation has one:

- reservation ID;
- `pending` / liable / settled lifecycle;
- expiry;
- progressive-growth cursor;
- logical-operation replay identity.

`markLiable()` and `renew()` operate on the whole vector. Renewal changes only lease time; it does not add capacity.

Pending expiry releases every reserved dimension atomically. Liable expiry conservatively retains every dimension at its full successfully reserved amount. Implementations must not create a synthetic scalar sum for vector recovery or telemetry.

## Settlement

Vector settlement reports every reservation dimension exactly once:

```ts
await lease.settle(
  [
    { key: 'requests', actualUnits: 1 },
    { key: 'tokens', actualUnits: 623 },
  ],
  'success',
);
```

For every dimension:

```text
0 <= actualUnits <= total successfully reserved units for that dimension
```

Unused units are released only from that dimension's budgets, and all releases plus the terminal reservation state commit atomically.

Identical settlement replay is idempotent. A different settlement for an already settled vector is rejected.

## Progressive vector growth

`VectorUsageLease.grow()` composes the v0.6 growth safety model across the whole vector. One growth attempt has:

- one stable `incrementId`;
- one Store-issued opaque growth cursor for the reservation;
- the complete dimension/budget topology;
- a non-negative `additionalUnits` value for every dimension;
- at least one positive increment.

Example:

```ts
await lease.grow({
  incrementId: 'step-0042',
  dimensions: [
    {
      key: 'requests',
      additionalUnits: 0,
      budgets: [{ key: 'user:requests:day', limit: 100 }],
    },
    {
      key: 'tokens',
      additionalUnits: 512,
      budgets: [{ key: 'user:tokens:day', limit: 100_000 }],
    },
  ],
});
```

The Store admits every requested increment atomically or none. Authoritative quota denial consumes no capacity but rotates the cursor and stores the denied replay result.

If an acknowledgement is lost after commit, retry the exact same `incrementId`, prior cursor, dimensions, limits, and increments. The Store replays the authoritative result. A fresh increment on the stale cursor fails closed. `VectorUsageLease` also pins an unresolved attempt locally so callers cannot accidentally continue with a fresh ID.

Settled or expired reservations reject every growth call, including replay, so acknowledgement recovery cannot authorize new metered work after terminal state.

## Provider storage compatibility

- **Memory** — tagged scalar/vector internal records; no scalar behavior change.
- **Redis** — vector metadata is additive in the existing reservation JSON (`mode: "vector"`, dimensions, cursor/replay metadata). Existing mode-less records remain scalar.
- **Firestore** — vector data uses additive optional reservation-document fields. Existing v0.6 scalar documents remain valid and are not rewritten.
- **Cloudflare Durable Objects** — schema v3 adds `reservation_vectors` as a sidecar table. Existing v1/v2 scalar accounting rows are not rewritten.

## Proof requirements

A Store should not claim vector support until it passes `runVectorUsageStoreConformance()` and its backend-specific integration evidence. The portable suite covers:

- atomic partial-denial rollback;
- concurrent admission;
- scalar/vector operation collision;
- vector growth replay/conflict and cursor serialization;
- denied-growth rollback and replay;
- pending/liable expiry;
- per-dimension settlement bounds and terminal behavior;
- growth/settlement races.

Built-in Redis, Firestore, and Cloudflare tests additionally inject committed-growth acknowledgement loss at their provider boundaries.

## Non-goals

v0.7 does not add:

- pricing, currency, or invoice semantics;
- conversion between dimensions;
- automatic aggregation of unlike units;
- optimistic continuation after an ambiguous Store write;
- independently committed per-dimension reservations presented as atomic.

For an MCP-oriented execution pattern, see [Vector MCP integration](vector-mcp-integration.md).
