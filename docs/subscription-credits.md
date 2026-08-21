# Subscription-style MCP credits

[English](subscription-credits.md) | [日本語](subscription-credits.ja.md)

A common product model is simple:

- Free users receive 50 MCP credits per calendar month;
- Plus users receive 100 MCP credits per calendar month;
- `search` costs 1 credit;
- `summarize` costs 3 credits;
- `ai_analyze` costs 5 credits;
- `browser_action` costs 10 credits.

`mcp-usage-control` can enforce that model without becoming the subscription system itself. The application remains responsible for entitlement truth and product configuration; MCPUsage turns the trusted result into concurrency-safe reserve/liability/settlement decisions.

## Recommended boundary

```text
subscription / entitlement service       application config
              \                         /
               \                       /
                -> trusted plan + limits + tool costs
                              |
                              v
                    UsagePolicy.quote()
                              |
                              v
                 MCPUsage enforcement Store
                 reserve -> liable -> settle
                              |
                  optional safe telemetry
                              |
                              v
            analytics / billing / history ledger
```

The lower ledger is optional and separate. It may consume privacy-safe events or application-owned business records, but it is **not** the authoritative source used to decide whether the current MCP operation may start.

MCPUsage does **not** own subscription truth, a pricing catalog, payment collection, durable customer usage history, invoices, or a billing/financial ledger. Those remain application/product concerns.

## Complete monthly weighted-credit example

The weighted-credit helper validates trusted in-memory configuration, while the window-key helper derives a stable monthly accounting identity.

```ts
import {
  MemoryUsageStore,
  UsageControl,
  createWeightedCreditsPolicy,
  createWindowedBudgetKey,
  defineWeightedCreditPolicyConfig,
} from 'mcp-usage-control';

const creditConfig = defineWeightedCreditPolicyConfig({
  tools: {
    search: 1,
    summarize: 3,
    ai_analyze: 5,
    browser_action: 10,
  },
  plans: {
    free: { limits: { monthly: 50 } },
    plus: { limits: { monthly: 100 } },
  },
  unknownTool: 'deny',
});

const monthlyKey = createWindowedBudgetKey({
  period: 'calendar-month',
  timeZone: 'Asia/Tokyo',
  namespace: 'credits',
  clock: Date.now,
});

const policy = createWeightedCreditsPolicy({
  config: creditConfig,

  // This resolver represents application-owned trusted entitlement truth.
  // It may read a server-side cache/service, but MCPUsage does not own it.
  resolvePlan: async request =>
    await applicationEntitlements.currentPlan(request.principal.id),

  budgets: ({ request, limit }) => ({
    key: monthlyKey.key({
      scope: 'user',
      id: request.principal.id,
    }),
    limit: limit('monthly'),
  }),
});

const control = new UsageControl(new MemoryUsageStore(), policy);

const request = {
  operationId: 'browser-action:42:request-0001',
  principal: { id: '42' },
  tool: 'browser_action',
  args: {},
};

const admission = await control.reserve(request);
if (!admission.allowed) {
  throw new Error(`usage denied: ${admission.reason}`);
}

await admission.lease.markLiable();
await performBrowserAction();
await admission.lease.settle(10, 'success');
```

For user `42` during August 2026 in Tokyo, the helper derives a key such as:

```text
credits:month:tz=Asia%2FTokyo:user:42:2026-08
```

Every configured tool shares that one scalar credit bucket. Only the quoted `units` differ.

For example, `browser_action` reserves 10 credits from the same 100-credit Plus allowance that `search` consumes 1 credit from. The Store performs admission atomically, so two concurrent calls cannot both spend the same remaining credits.

Use a production Store such as Redis, Cloudflare Durable Objects, or Firestore when enforcement state must survive process restart or be shared across application instances. `MemoryUsageStore` above is only the compact example.

## Entitlement lookup stays outside MCPUsage

The `resolvePlan` callback is an integration seam, not a subscription database.

Good responsibilities for the application include:

- resolving whether the user is currently `free` or `plus` from trusted server-side state;
- deciding whether a trial or operator override changes the effective plan/limit;
- loading and distributing reviewed tool-cost/plan-limit configuration;
- deciding the rollout/caching policy for that configuration.

MCPUsage should receive the resulting trusted plan and limits. It should not directly become the source of truth for RevenueCat, Stripe, App Store, Google Play, Firebase Remote Config, or another commercial subscription provider.

## Free -> Plus during the same month

Suppose a Free user has already consumed 30 of 50 August credits and upgrades to Plus.

Before upgrade:

```text
key   = credits:month:tz=Asia%2FTokyo:user:42:2026-08
limit = 50
used  = 30
headroom = 20
```

After upgrade, keep **the same key** and quote the Plus limit:

```text
key   = credits:month:tz=Asia%2FTokyo:user:42:2026-08
limit = 100
used  = 30
headroom = 70
```

Do not add `plus` to the key and do not manufacture a fresh August bucket. The Store keeps the already-consumed 30 credits authoritative and simply evaluates future admission against the new effective limit.

This is the same-key mutable-limit contract described in [Mutable quota limits](mutable-quota-limits.md).

## Downgrade and trial expiry

The reverse rule is equally important. Suppose a user has consumed 80 credits while their effective limit was 100, then the account downgrades to Free with a 50-credit limit during the same month.

Keep the same key and quote limit `50`:

```text
used  = 80
limit = 50
remaining admission capacity = 0
```

The existing 80 credits are not refunded, truncated, or rewritten. New reservations are denied until a legitimate new window begins or policy changes again.

A trial that temporarily raises the normal monthly allowance should normally behave the same way: trial expiry lowers the effective limit on the same monthly key. If the product truly intends a trial to be an independent pool, model that as a separate budget from the start rather than switching keys after consumption has accumulated.

## Legitimate monthly rollover

A calendar-window change is a legitimate reason to select a new accounting key.

With the same helper configuration:

```text
August:    credits:month:tz=Asia%2FTokyo:user:42:2026-08
September: credits:month:tz=Asia%2FTokyo:user:42:2026-09
```

The Store does not watch the wall clock and does not reset a counter in place. The application derives a different key for the new month. That new key denotes a genuinely different accounting bucket.

Changing `namespace`, `period`, timezone configuration, scope naming, or subject-ID format also changes accounting identity. Treat those changes as quota-key migrations; see [Accounting-window budget keys](accounting-window-keys.md).

Subscription-anniversary periods or fiscal calendars are deliberately not built into the helper. When the business window is not a calendar day/month, derive the exact stable `Budget.key` in application policy.

## Dynamic-cost tools: reserve a safe maximum, settle actual usage

Some tool cost is known only after execution. For example, a document-analysis operation may cost between 1 and 20 credits depending on the work performed.

Reserve a conservative maximum before starting cost-bearing work, then settle the actual amount:

```ts
import {
  MemoryUsageStore,
  UsageControl,
  type UsagePolicy,
  type UsageRequest,
} from 'mcp-usage-control';

const SAFE_MAX_CREDITS = 20;

const dynamicPolicy: UsagePolicy = {
  async quote(request: UsageRequest) {
    const plan = await applicationEntitlements.currentPlan(request.principal.id);
    const monthlyLimit = plan === 'plus' ? 100 : 50;

    return {
      decision: 'allow',
      units: SAFE_MAX_CREDITS,
      budget: {
        key: monthlyKey.key({ scope: 'user', id: request.principal.id }),
        limit: monthlyLimit,
      },
    };
  },
};

const dynamicControl = new UsageControl(new MemoryUsageStore(), dynamicPolicy);
const dynamicRequest: UsageRequest = {
  operationId: 'dynamic-analysis:42:request-0001',
  principal: { id: '42' },
  tool: 'dynamic_analysis',
  args: {},
};
const admission = await dynamicControl.reserve(dynamicRequest);

if (!admission.allowed) {
  throw new Error(`usage denied: ${admission.reason}`);
}

await admission.lease.markLiable();
const result = await performDynamicWork();

// Must be a non-negative integer no larger than the currently reserved amount.
await admission.lease.settle(result.actualCredits, 'success');
```

The unused portion of the reservation is released at settlement. Do not reserve only the expected average if the operation can safely incur more before the Store has authorized it.

### When the maximum is impractical

If a realistic worst-case reservation is too large or the operation naturally grows in stages, use optional progressive reservation growth with a Store that implements `ProgressiveUsageStore`:

```ts
const currentPlan = await applicationEntitlements.currentPlan(dynamicRequest.principal.id);
const currentMonthlyLimit = currentPlan === 'plus' ? 100 : 50;

const growth = await admission.lease.grow({
  incrementId: 'batch-0042',
  additionalUnits: 10,
  budgets: [
    {
      key: monthlyKey.key({ scope: 'user', id: dynamicRequest.principal.id }),
      limit: currentMonthlyLimit,
    },
  ],
});

if (!growth.accepted) {
  // Stop before incurring the additional metered work.
}
```

Each growth step must be authorized **before** the extra cost is incurred. Use a stable `incrementId`; if a growth acknowledgement is ambiguous, retry the exact same growth attempt rather than creating a second increment. See [Progressive MCP growth](progressive-mcp-integration.md).

## Scalar credits or vector usage?

Use **one scalar credit currency** when the product intentionally defines one exchange rate across tools:

```text
search = 1 credit
summarize = 3 credits
ai_analyze = 5 credits
browser_action = 10 credits
```

All of those costs consume the same fungible allowance, so scalar `UsagePolicy` / `UsageControl` is the natural model.

Use **vector usage** when one logical operation consumes unlike dimensions that must remain independently limited and atomically admitted, for example:

```text
requests = 1
input_tokens = 12,000
GPU_ms = 850
```

Do not sum unlike units merely because the vector API exists. Conversely, do not invent a fake credit conversion if the product does not actually define one. The decision rule is:

> If the product treats units as mutually substitutable through one intentional exchange rate, use scalar credits. If the dimensions have independent limits/meaning and must be enforced together, use `VectorUsagePolicy` / `VectorUsageControl`.

See [Atomic heterogeneous usage vectors](vector-usage.md).

## Configuration rollout consistency

The Store serializes authoritative usage updates. It does **not** provide distributed consensus for the configuration used by every caller.

If one application instance believes Plus means 100 credits while another stale instance still uses 120, both may make internally valid admission decisions against different ceilings for the same key. A strict downgrade or price/weight cutover therefore requires an application-level rollout strategy, such as:

- centrally read/versioned policy configuration;
- bounded cache TTL plus coordinated invalidation;
- deployment sequencing that prevents stale instances from serving traffic;
- routing or availability controls during a strict cutover.

The same warning applies when changing tool weights. `defineWeightedCreditPolicyConfig()` snapshots the object supplied to one policy instance so accidental local mutation cannot silently change it, but distribution/version consistency across processes remains application-owned.

## Enforcement state is not usage history or a billing ledger

The Store keeps the minimum authoritative state needed for concurrency-safe enforcement, replay protection, reservation lifecycle, expiry recovery, and settlement. That state is not a customer-facing history database and not a financial ledger.

If the product needs “show me every tool call this month,” invoices, payment reconciliation, revenue recognition, audit exports, or long-term usage analytics, write those records to a separate application-owned system with the retention, privacy, and durability guarantees that use case requires.

Do not reconstruct a financial ledger by scraping implementation-specific Store keys, and do not make optional telemetry a second enforcement truth.

## Responsibility checklist

| Concern | Owner |
| --- | --- |
| Current plan / entitlement | Application / subscription system |
| Tool credit weights | Application configuration |
| Monthly allowance by plan | Application configuration |
| Calendar day/month key derivation | Application using `createWindowedBudgetKey()` |
| Atomic quota admission | MCPUsage Store |
| Pending -> liable -> settled lifecycle | MCPUsage |
| Retry/idempotency accounting | MCPUsage + application-stable operation identity |
| Subscription purchase/payment collection | Outside MCPUsage |
| Invoices / financial ledger | Outside MCPUsage |
| Durable customer usage history / analytics | Separate application-owned store |

## Related guides

- [Accounting-window budget keys](accounting-window-keys.md)
- [Mutable quota limits](mutable-quota-limits.md)
- [MCP integration](mcp-integration.md)
- [Progressive MCP growth](progressive-mcp-integration.md)
- [Atomic heterogeneous usage vectors](vector-usage.md)
- [API reference](api-reference.md)
