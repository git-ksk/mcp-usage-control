# Getting started

[English](getting-started.md) | [日本語](getting-started.ja.md)

Add a monthly credit limit to a tool, then choose the integration and storage your application needs. This guide starts with a runnable local example and introduces the production boundaries afterward.

## Install

Use **Node.js 22+ and ESM**. CI covers Node.js 22 and 24.

```sh
npm install mcp-usage-control
```

The core includes `MemoryUsageStore`, so the example needs no external service. For a repository checkout or release archive, use [Source / local tarballs](using-from-source.md).

## Three concepts to remember

| Concept | Responsibility |
| --- | --- |
| **Policy** | Quotes the cost and selects the budgets that apply to a call |
| **Store** | Reserves and updates every participating budget atomically |
| **Lease** | Represents the reservation: `markLiable()`, `renew()`, and `settle()` control its lifecycle |

The library owns usage enforcement. Your application supplies trusted identity, plan entitlements, cost measurement, and business-side-effect idempotency. Billing and authentication are separate responsibilities.

## Smallest example

Save this as `demo.mjs`, then run `node demo.mjs`. It reserves 10 credits against a 50-credit calendar-month budget, runs a mock report, and settles 3 credits. The unused 7 credits become available again.

```js
import {
  MemoryUsageStore,
  UsageControl,
  createWindowedBudgetKey,
} from 'mcp-usage-control';

const monthly = createWindowedBudgetKey({
  period: 'calendar-month',
  timeZone: 'UTC',
  namespace: 'credits',
  clock: Date.now,
});

const control = new UsageControl(new MemoryUsageStore(), {
  quote({ principal, tool }) {
    if (tool !== 'report') return { decision: 'deny', reason: 'unsupported_tool' };
    return {
      decision: 'allow',
      units: 10,
      budget: {
        key: monthly.key({ scope: 'user', id: principal.id }),
        limit: 50,
      },
    };
  },
});

// Replace this mock with your metered provider call.
async function performMeteredWork() {
  return { text: 'Example report', actualUnits: 3 };
}

async function runReport(operationId) {
  const admission = await control.reserve({
    operationId,
    principal: { id: 'user-42' },
    tool: 'report',
    args: {},
  });
  if (!admission.allowed) {
    throw new Error(`usage denied: ${admission.reason}`);
  }

  await admission.lease.markLiable();
  let result;
  try {
    result = await performMeteredWork();
  } catch (error) {
    // Unknown cost: conservatively retain the reserved amount.
    await admission.lease.settle(admission.lease.reservedUnits, 'error');
    throw error;
  }

  // Outside the handler catch: a settlement error must not trigger another settlement.
  await admission.lease.settle(result.actualUnits, 'success');
  return result.text;
}

console.log(await runReport('report-001')); // Example report
```

This is a short-running, single-user demonstration. In an application, derive the principal from trusted authentication and reuse a stable operation ID for retries. Use actual usage only when it is known, and keep it within the reserved amount.

### What does `markLiable()` mean?

It records the point immediately before work may incur cost. An expired **pending** reservation can release capacity. After it becomes **cost-liable**, unknown usage retains the full reservation conservatively. A worker crash after paid work may have begun is therefore not an automatic refund.

### What does `settle()` do?

It finalizes actual usage and releases any unused reservation. Settle zero only when the application knows that no metered resource was consumed. An exception by itself does not prove zero cost.

If settlement fails with an ambiguous outcome, do not immediately issue a second settlement or reserve again. Follow the selected store's [reconciliation contract](operation-reconciliation.md). An accounting failure can occur even after the business operation succeeded; result recovery belongs to the application.

Long-running direct-core integrations must renew the lease while authoritative work remains active. The MCP wrapper handles renewal by default. See [MCP integration](mcp-integration.md).

## Budget windows and several budgets

The example uses `createWindowedBudgetKey()` to select the current calendar month in UTC. The store does not automatically reset a counter in place. A new key selects a new accounting bucket; changing timezone, namespace, or identity mapping can change which budget is enforced.

Use [accounting-window keys](accounting-window-keys.md) for calendar windows and [subscription credits](subscription-credits.md) for Free/Plus plans and weighted tool costs. Custom subscription billing cycles remain application-defined.

One quote may return `budgets` instead of `budget` to enforce user-daily, user-monthly, and tenant-monthly limits together. Admission is **all-or-nothing**: every budget reserves or none does. Build each key from the intended trusted scope and period.

## Which package should I use?

| Integration | Install |
| --- | --- |
| Local example or custom lifecycle | `mcp-usage-control` |
| MCP TypeScript SDK v2 tools | Core + `mcp-usage-control-mcp` |
| Durable or shared enforcement | Add one of the store adapters below |

For an MCP server backed by Redis:

```sh
npm install mcp-usage-control mcp-usage-control-mcp mcp-usage-control-redis @modelcontextprotocol/server@^2.0.0 redis@^6.2.0
```

`mcp-usage-control-mcp` wraps handlers inside your server. It is not a separate gateway. [The integration guide](mcp-integration.md) covers `protectTool()`, tools without an input schema, and integrity-verified multi-round `input_required` flows.

## Choosing a production store

| Store | Good fit | Main trade-off |
| --- | --- | --- |
| [Memory](memory-store.md) | Local tests and controlled single-process use | State is lost on restart and is not shared |
| [Redis](redis.md) | Shared quotas and frequent updates | Persistence and HA need deployment planning |
| [Cloudflare Durable Objects](cloudflare.md) | Cloudflare deployments | One Durable Object is one transaction domain |
| [Firestore](firestore.md) | Firebase/GCP and mostly user-scoped budgets | Heavily shared budget documents can become contention hotspots |

Provider guides describe the supported clock, durability, and failure behavior. A passing Memory example does not verify a production provider deployment.

## Reuse the same `operationId` for retries

Replay protection is scoped to `(tenantId, principal.id, tool, operationId)` during retention. Duplicate admission is rejected; this does not replay the business result. Do not generate a fresh ID just to bypass a `duplicate_operation` denial.

## Run the concurrency proof

With Node.js 22+ and the repository's pinned pnpm 10.15.0:

```sh
git clone https://github.com/git-ksk/mcp-usage-control.git
cd mcp-usage-control
pnpm install --frozen-lockfile
pnpm example:free-plus
```

The [Free/Plus example](../examples/free-plus-credits/README.md) verifies that exactly one of two reports can reserve the final 10 credits and that a duplicate operation cannot reserve again.

## What to read next

- Integrate a tool: [MCP integration](mcp-integration.md).
- Model product plans: [Subscription credits](subscription-credits.md).
- Diagnose failures: [Troubleshooting](troubleshooting.md).
- Review all public APIs: [API reference](api-reference.md).
- Explore the design: [Architecture](architecture.md) and [Store contract](store-contract.md).
