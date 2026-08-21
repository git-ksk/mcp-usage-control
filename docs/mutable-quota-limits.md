# Mutable quota limits

[English](mutable-quota-limits.md) | [日本語](mutable-quota-limits.ja.md)

Applications may change an effective quota while the same accounting bucket already contains reserved or consumed usage. Common examples are plan upgrades/downgrades, trial expiry, temporary operational overrides, and tenant-specific limit changes.

`mcp-usage-control` treats the supplied `budget.limit` as the **effective admission ceiling for that reserve attempt**. It does not store a permanent limit definition in the accounting bucket. The authoritative usage already attached to the same `budget.key` remains intact.

For a complete Free/Plus monthly weighted-credit example, see [Subscription-style MCP credits](subscription-credits.md).

## Same key means same accounting bucket

For one `budget.key`:

- increasing the effective limit preserves all existing reserved/consumed usage and opens only the newly available headroom;
- decreasing the effective limit preserves all existing reserved/consumed usage and denies new admission while usage is at or above the lower limit;
- a decrease does not refund, rewrite, cancel, or shrink an existing reservation;
- an active pending or cost-liable reservation remains valid and can continue through its normal liability/renewal/settlement lifecycle;
- changing a plan or override does not require a new budget key unless the application intentionally means a new accounting bucket/window.

The store calculates admission from its authoritative usage state and the limit supplied for the current request. Conceptually:

```text
remaining = max(0, effectiveLimit - authoritativeUsedOrReserved)
```

The configured limit is therefore policy input; authoritative usage is Store state.

## Upgrade example: Free -> Pro

Suppose `month:user-42:2026-08` already contains 80 units.

```text
Free limit = 100
Pro limit  = 300
```

After upgrade, keep the same key and quote limit `300`. The existing 80 units remain counted; new admission has 220 units of headroom. Do not create a new key such as `month:user-42:2026-08:pro` merely to obtain a larger allowance unless you truly intend a separate accounting bucket.

## Downgrade example: Pro -> Free

Suppose the same bucket contains 180 units when the effective limit changes from 300 to 100.

Keep the same key and quote limit `100`. Existing 180 units remain authoritative. New admission is denied with zero remaining capacity until policy or the accounting window changes legitimately. The downgrade does not rewrite the bucket to 100 or refund 80 units.

## Trial expiry

If a trial temporarily raises an existing monthly quota, trial expiry should normally lower the effective limit on the **same monthly key**. Usage incurred during the trial stays counted for that accounting window.

If product semantics instead define the trial as a genuinely independent budget, model it as a separate budget from the beginning rather than changing keys after usage has already accumulated.

## Temporary override

A temporary increase may be applied by quoting a higher limit for the same key. When the override ends, return to the normal lower limit. Already-incurred usage remains unchanged.

This project does not store the override, its expiry, administrator identity, or entitlement history. Those remain application policy concerns.

## Concurrent old/new policy views

`UsageStore` provides atomic accounting, **not distributed policy-version consensus**.

If two application instances concurrently call `reserve()` for the same key with different effective limits, each transaction evaluates the authoritative usage against the limit supplied by that caller. For example, if usage is already `1`:

- a caller quoting limit `1` must deny;
- a stale caller still quoting limit `2` may admit one more unit.

That behavior is intentional and is covered by the portable conformance runner. A strict downgrade cutover therefore requires the application to make policy rollout sufficiently consistent before accepting traffic under the new limit. Typical solutions include centrally read policy, versioned configuration, coordinated rollout, or routing/availability controls appropriate to the application.

`mcp-usage-control` does not turn the Store into a subscription database or distributed configuration service.

## Active reservations during a limit change

Limit changes affect **future admission decisions**. They do not mutate the contract of already committed reservations.

- pending reservations remain reserved;
- cost-liable reservations remain conservatively charged;
- renewal does not re-price or re-admit the reservation against a newer limit;
- settlement still releases only `reservedUnits - actualUnits` and retains actual usage normally.

If an application needs administrative cancellation or entitlement revocation semantics, that is a separate application control plane and must not silently rewrite authoritative usage accounting.

## Do not reset usage by changing keys

Changing a `budget.key` creates a different accounting bucket. Do not use key rotation as a shortcut for plan changes, downgrades, temporary overrides, or administrative corrections when the intended accounting window is still the same.

Likewise, `MemoryUsageStore.retireBudgetKey()` is only for a bucket whose accounting window is permanently over and whose key will not be reused for that same window. It is not a quota-reset or plan-change API.

Legitimate key changes include a genuinely new application-owned window, for example:

```text
month:user-42:2026-08
month:user-42:2026-09
```

The application owns when such a window changes; Store implementations do not infer it.

## Portable evidence

The `mcp-usage-control/conformance` runner verifies the same mutable-limit contract across compatible Stores, including:

- limit increase with preserved existing usage;
- limit decrease while a reservation is pending and cost-liable;
- no refund of settled/consumed usage after a decrease;
- concurrent callers presenting stricter and stale-higher limits.

Built-in CI runs that contract against Memory, Redis, Cloudflare Durable Objects via local workerd, and Firestore via the Local Emulator Suite.
