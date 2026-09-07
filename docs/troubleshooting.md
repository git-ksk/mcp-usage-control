# Troubleshooting

[English](troubleshooting.md) | [日本語](troubleshooting.ja.md)

Start with the symptom below. Preserve the original operation identity and error when diagnosing a failure; changing IDs or clearing accounting state can hide the cause and admit work twice.

## Find the right path

| Symptom | First check | Details |
| --- | --- | --- |
| Package or runtime error | Node.js version, ESM mode, installed packages and peers | [Getting started](getting-started.md) |
| `duplicate_operation` | Whether this is a retry of an existing operation | [Operation reconciliation](operation-reconciliation.md) |
| `quota_exceeded` | All budgets in the quote, not only the displayed user budget | [Budget windows](accounting-window-keys.md) |
| Lease expires during work | Renewal, process pauses, and store connectivity | [MCP integration](mcp-integration.md) |
| Quota resets after restart | Whether `MemoryUsageStore` is in use | [Choose a store](getting-started.md#choosing-a-production-store) |
| Firestore transaction contention | How many requests share the same budget document | [Firestore](firestore.md) |

## Installation or runtime errors

Use Node.js 22+ and ESM (`.mjs` or `"type": "module"` in your application). Start with `npm install mcp-usage-control`; an MCP server also needs the MCP adapter and its SDK peer. Install one store adapter for the chosen backend. See the provider guide for its client dependency.

For repository development, check both `node --version` and `pnpm --version`. The repository pins pnpm 10.15.0. A system pnpm executable may use a different Node.js version from your editor. If a pnpm error mentions `node:sqlite`, first verify the active Node/pnpm pair instead of changing application code.

For local archives, use [Source / local tarballs](using-from-source.md). Do not import `mcp-usage-control-cloudflare/worker` in plain Node.js; that entry point requires the Workers runtime.

## A retry is denied as `duplicate_operation`

This denial is intentional during replay retention. Reuse the same `operationId` for the same logical operation, but do not expect duplicate admission to replay the business result. The replay scope is `(tenantId, principal.id, tool, operationId)`.

If an acknowledgement was lost, follow the selected store's [reconciliation path](operation-reconciliation.md) where supported. Do not generate a fresh ID merely to bypass the guard. Business-result recovery and side-effect idempotency are application responsibilities.

## `quota_exceeded` despite a visible remaining balance

Inspect every budget in the quote. A user may have capacity while a tenant or daily budget is exhausted. One exhausted budget denies the whole reservation.

Use the authoritative `remainingByBudget` returned on successful admission for that point in time; it is not a promise of capacity for later requests. Do not subtract a local counter from a plan limit or collapse unrelated budgets into one balance. Check that [window keys](accounting-window-keys.md) select the intended timezone, identity, and period.

## Can I call `settle(0)` after an error?

Only when the application knows no metered resource was consumed. A timeout, thrown exception, cancellation acknowledgement, or process crash does not by itself prove zero cost. Unknown usage after `markLiable()` stays conservative.

Keep the successful settlement outside the business-handler `catch`. Otherwise, a settlement failure can accidentally trigger a second settlement with a different outcome. See the complete example in [Getting started](getting-started.md).

## Requests fail when the Store is unavailable

An authoritative store failure does not become an unmetered allow. Restore connectivity or handle the error at the product boundary. Preserve ambiguous write outcomes for provider-specific reconciliation; do not blindly replay state-changing calls.

If accounting integrity may be affected, use the [incident-response guide](incident-response.md) before changing stored state.

## My long-running tool expires

`protectTool()` renews active leases by default. Direct-core integrations need their own renewal loop. Check process pauses, connection failures, TTL, and renewal timing against the selected store's contract. A lease-loss signal also needs application/provider-specific handling; the generic core cannot undo an external side effect.

## Memory works locally but resets in production

`MemoryUsageStore` is process-local and loses its state on restart. It is appropriate for tests or controlled single-process deployments that accept that loss. Shared or durable enforcement needs Redis, Cloudflare Durable Objects, or Firestore.

## Firestore gets contention on a shared quota

The same budget key maps to the same document. A heavily shared tenant/global budget can become a transaction hotspot. Check participant count and workload shape against the [Firestore guide](firestore.md), then validate the actual workload before choosing another storage layout.

## Still stuck?

Follow [Support](../SUPPORT.md) and include a minimal reproduction, versions, the selected store, and sanitized error details. Report security-sensitive defects through [Security](../SECURITY.md), not a public issue.
