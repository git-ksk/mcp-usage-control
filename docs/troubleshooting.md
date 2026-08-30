# Troubleshooting

Use this page when the integration works mechanically but usage behavior looks wrong.

## A retry is denied as `duplicate_operation`

Reuse the same `operationId` only for the same logical operation. Duplicate admission is intentionally rejected; do not respond by generating a fresh ID just to bypass the guard. If a state-changing acknowledgement was lost, use the Store's documented reconciliation path where supported instead of blindly reserving again.

## Can I call `settle(0)` after an error?

Only when the application can prove that no metered resource was consumed. Once work may have incurred cost, unknown outcomes should remain conservative rather than becoming an automatic refund.

## Requests fail when the Store is unavailable

That is the default safety contract. An ambiguous authoritative Store failure does not become an unmetered allow. Restore the Store or handle the denial/error at the product boundary; do not add a generic fail-open path around enforcement.

## My long-running tool expires

The lease must remain authoritatively renewed while metered execution is active. `protectTool()` provides heartbeat renewal for the supported MCP wrapper path. Direct-core integrations need an equivalent renewal loop sized for their execution duration and Store behavior.

## Firestore gets contention on a shared quota

Firestore is a good fit for many user-scoped budgets, but a single heavily shared budget can become a transaction hotspot. Use the provider guidance in [Firestore](firestore.md); high-frequency shared quotas may be a better fit for Redis or another serialization domain.

## Memory works locally but resets in production

`MemoryUsageStore` is process-local and restart-volatile. Use it for tests, examples, or controlled single-process deployments that accept restart loss. Multi-instance or restart-durable enforcement needs a shared production Store.

## Which package should I install first?

For an MCP TypeScript server, start conceptually with `mcp-usage-control` plus `mcp-usage-control-mcp`. Add one production Store adapter only when you choose the deployment backend. Until npm publication, follow [Use from source / local tarballs](using-from-source.md).
