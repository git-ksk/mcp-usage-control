# Runnable MCP server + client: `protectTool()`

[日本語](README.ja.md)

This example **starts a real HTTP MCP server on a random `127.0.0.1` port**, calls it with the official MCP v2 client, and exits with failing assertions on incorrect accounting. It uses no external API, credential, network service, paid model, or database.

From a clean repository checkout (Node.js **22+**, pnpm **10.15.0**):

```sh
pnpm install --frozen-lockfile
pnpm example:mcp
```

Expected output:

```text
PASS: real loopback MCP calls settle actual usage; duplicates and exhausted budgets deny before work.
PASS: unknown post-dispatch cost does not silently refund; no business replay.
```

## What this demonstrates

- The official `@modelcontextprotocol/server` creates and registers a protected `demo-report` tool, served using a loopback Node HTTP listener. The official `@modelcontextprotocol/client` connects over Streamable HTTP. Both ends are closed before the command exits.
- A policy reserves a **maximum of 5 units** per invocation against one **8-unit** quota. Normal handler results prove **3 actual units**. Two successful calls therefore consume 6 units; the third attempt cannot reserve 5 and is denied **before the metered handler executes**. The script asserts handler entry counts; it does not infer quota from telemetry alone.
- Reusing a validated demo action UUID is denied as a `duplicate_operation`; it **does not** recover or replay an already completed report. Intentional new actions have new IDs. The demonstration treats these UUIDs as application action identifiers—not proof of who is authorized. A read tool with no validated product-level action key must instead assign a **fresh server-side UUID per received dispatch**, accepting that independent transport retries may consume quota twice. See [logical operation identity](../../docs/mcp-operation-identity.md).
- The `unknown-cost` path fails *after* metered handler entry. It is conservatively settled at the entire 5-unit maximum; the next 5-unit call is denied, even though the error did not prove actual usage. Zero settlement is allowed only with reliable evidence that no metered work occurred.
- The official SDK can serialize **raw `Error.message`** from the wrapped server handler into an MCP tool result. For this reason the demo places an **explicit error-sanitizing server boundary** around `protectTool()` and returns a single non-sensitive `isError` text for denied, Store, classification and settlement exceptions. The optional `onProtectedError` fixture hook is only for trusted local verification; a production application must connect its own access-controlled, redacted diagnostics. Clients must not assume that MCP `isError` exposes the server-side exception class. A regression test injects a secret-looking backend error and proves it is not on the wire.

### HTTP request and tool-input bounds (v1.3.1 security patch)

This example has two independent limits: it rejects bodies over **64 KiB** with HTTP 413 before SDK parsing, and configures `new McpServer(info, { maxToolInputElements: 128 })`. It also creates a **fresh `McpServer` from the `createMcpHandler` factory for each request**, never sharing an SDK transport or server across clients. The 128-element cap is intentionally ample for this example's two scalar arguments, not a universal production default. Production servers must choose a limit above their legitimate largest tool input and apply a `maxRequestBodySize` / framework parser limit as well. **The SDK upgrade alone does not enable `maxToolInputElements`**. [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) · [GHSA-jm63-cq47-j5jp](https://github.com/advisories/GHSA-jm63-cq47-j5jp).

The `mcp-usage-control-mcp` adapter does not instantiate the HTTP SDK server or impose transport limits on library consumers. Its supported server peer minimum is now `@modelcontextprotocol/server@2.3.1` to exclude the known-vulnerable SDK. Existing callers pinning 2.0.0–2.2.x must upgrade **and** implement the input limits / per-client transport isolation before deploying; this is a security-motivated peer compatibility floor change.

## Security boundary and production adoption

`server.mjs` deliberately uses a **fixed, shared, demo-only principal**. It is safe only on its loopback listener with non-destructive local fake work. **Do not expose this server publicly or deploy it with paid tools.** Production applications must authenticate each caller on the server, derive `tenantId`, principal/plan and budget scope from trusted server-side context, define action-ID lifecycle and business-result idempotency, and classify the provider's true incurred cost.

The example's `MemoryUsageStore` is process-local: restart resets the quota and multiple replicas do not share it. For durable/shared usage enforcement use one of [Redis](../../docs/redis.md), [Cloudflare Durable Objects](../../docs/cloudflare.md), or [Firestore](../../docs/firestore.md), and verify each provider's supported durability/clock/atomicity/failover boundaries. This example **does not** prove the production safety of a distributed deployment. Multi-round `input_required` needs `protectMultiRoundTool()` with integrity-verified request state and a shared atomic flow store; this sample is deliberately single-round.

For failure/ACK ambiguity, operator decisions, and reconciliation see [troubleshooting](../../docs/troubleshooting.md), [operation reconciliation](../../docs/operation-reconciliation.md), and [incident response](../../docs/incident-response.md). For the standalone Core concurrency sample see [Free/Plus credits](../free-plus-credits/README.md). For generic API usage see [Getting started](../../docs/getting-started.md) and [MCP integration](../../docs/mcp-integration.md).
