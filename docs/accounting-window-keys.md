# Accounting-window budget keys

[English](accounting-window-keys.md) | [日本語](accounting-window-keys.ja.md)

`mcp-usage-control` Stores do not rotate quota windows by watching wall-clock time. The application selects the authoritative bucket by choosing a `Budget.key`.

For common calendar-day and calendar-month quotas, `createWindowedBudgetKey()` provides deterministic timezone-aware key construction without moving subscription, billing-calendar, or Store state into core.

## Calendar month example

```ts
import { createWindowedBudgetKey } from 'mcp-usage-control';

const monthly = createWindowedBudgetKey({
  period: 'calendar-month',
  timeZone: 'Asia/Tokyo',
  namespace: 'credits',
});

monthly.key({
  scope: 'user',
  id: '42',
  now: new Date('2026-08-22T03:00:00+09:00'),
});
// credits:month:tz=Asia%2FTokyo:user:42:2026-08
```

The helper encodes `namespace`, `scope`, and `id` components so a delimiter inside an identity cannot collide with another component layout.

## Calendar day example

```ts
const daily = createWindowedBudgetKey({
  period: 'calendar-day',
  timeZone: 'America/New_York',
  namespace: 'requests',
});

const key = daily.key({ scope: 'tenant', id: 'acme', now: Date.now() });
```

The date is derived in the configured timezone, including DST/calendar boundaries supported by the host ICU implementation.

## Injectable clock

Use a trusted clock when one call site should share deterministic time without passing `now` every time:

```ts
const monthly = createWindowedBudgetKey({
  period: 'calendar-month',
  timeZone: 'UTC',
  namespace: 'credits',
  clock: () => fixedNow,
});
```

`key({ now })` takes precedence over `clock`. The helper is otherwise pure: it does not mutate Store state, retire old buckets, or schedule rollover work.

## Compose with weighted credits

```ts
import {
  createWeightedCreditsPolicy,
  createWindowedBudgetKey,
} from 'mcp-usage-control';

const monthly = createWindowedBudgetKey({
  period: 'calendar-month',
  timeZone: 'Asia/Tokyo',
  namespace: 'credits',
  clock: Date.now,
});

const policy = createWeightedCreditsPolicy({
  config: {
    tools: { search: 1, summarize: 3, ai_analyze: 5, browser_action: 10 },
    plans: {
      free: { limits: { monthly: 50 } },
      plus: { limits: { monthly: 100 } },
    },
    unknownTool: 'deny',
  },
  budgets: ({ request, limit }) => ({
    key: monthly.key({ scope: 'user', id: request.principal.id }),
    limit: limit('monthly'),
  }),
});
```

A Free -> Plus change inside the same month keeps the same key and changes only the effective limit. Existing authoritative consumption is preserved. A new month intentionally derives a different key.

An active reservation using progressive growth is different: growth stays pinned to the original reservation's budget-key set. If the operation crosses a calendar boundary, do not re-derive a new-window key for that growth. New-window keys are for new reservations that start in that window.

## Identity-change hazards

Changing any of these changes accounting identity and can select fresh authoritative state:

- `namespace`;
- `period`;
- the configured timezone literal;
- `scope` shape/name;
- the subject `id` format.

The timezone literal is intentionally embedded in the key. Changing `UTC` to `Asia/Tokyo`, or even changing to a different accepted alias spelling, creates a different key identity rather than silently reusing a bucket whose rollover boundary changed.

Treat these configuration changes like a quota-key migration. Do not roll them out casually mid-window unless selecting fresh accounting state is intentional.

## Historical window retention

Deriving a new window key does **not** mutate, reset, or retire the previous bucket. This preserves authoritative historical enforcement state, but it also means long-running deployments must choose an explicit retention policy before historical keys grow without bound.

Retire or prune an old key only after the application has established that the exact accounting window is permanently over, no active reservation still references it, and any required replay/reconciliation horizon has passed. `MemoryUsageStore.retireBudgetKey()` and the optional Cloudflare historical budget pruning API are explicit lifecycle tools; neither infers window age automatically. See [Memory Store](memory-store.md) and [Cloudflare historical budget pruning](cloudflare-budget-pruning.md).

## What remains application-owned

The helper does **not** implement:

- subscription renewal/anniversary billing cycles;
- arbitrary fiscal calendars;
- RevenueCat, Stripe, Firebase, Remote Config, or file loading;
- entitlement truth;
- old-window retirement;
- billing/history ledgers.

For a provider-specific or anniversary billing period, keep the window resolver application-owned and build the exact `Budget.key` explicitly. The Store should still receive only the resulting stable key and effective limit.

## Related guides

- [Subscription-style MCP credits](subscription-credits.md)
- [Mutable quota limits](mutable-quota-limits.md)
