# MCP protocol conformance

[English](mcp-conformance.md) | [日本語](mcp-conformance.ja.md)

This document records the protocol-level proof for the current MCP adapter boundary. It is intentionally narrower than a new feature design: the goal is to verify that the existing transactional accounting model remains correct under the current MCP multi-round request/response behavior.

## Verified baseline

The repository currently locks `@modelcontextprotocol/client` and `@modelcontextprotocol/server` at `2.0.0` for tests. The current conformance integration test explicitly pins the client to MCP protocol revision `2026-07-28` rather than relying on legacy fallback.

The proof uses the official SDK path:

```text
Client
  -> StreamableHTTPClientTransport
  -> createMcpHandler
  -> McpServer
  -> protectMultiRoundTool()
```

The adapter remains SDK-independent below `mcp-usage-control-mcp`; no protocol-specific state is added to the core `UsageStore` contract.

## Fresh-request multi-round proof

`packages/mcp/src/current-protocol.integration.test.ts` proves the following as one protocol exchange:

1. the client connects with protocol revision `2026-07-28` pinned and reports the `modern` era;
2. round 0 enters one `createMcpHandler` instance and returns `input_required`;
3. the SDK retries the logical tool call as a fresh MCP request;
4. round 1 is deliberately routed to a different `createMcpHandler` instance;
5. the two handler entries have different MCP request IDs;
6. policy quote/reservation runs exactly once for the logical operation;
7. the resumed round completes against the original usage lease and settlement releases the unused reservation.

This is the required accounting property: a fresh MCP request does not imply a fresh usage reservation.

## Horizontal scale and session affinity

The MCP adapter does not require a sticky MCP session for multi-round accounting. Resume authority comes from shared accounting state, not from the identity of the HTTP handler that served the previous round.

The conformance test crosses two independent handler instances while sharing the usage controller and flow store. This proves the adapter does not depend on handler-local MCP session state.

For real multi-process or horizontally scaled deployment, process-local Memory stores are not sufficient. The deployment must provide authoritative shared state for both sides of the accounting boundary:

- a shared/durable `UsageStore` for reservations, liability, renewal, and settlement;
- a shared/durable `McpUsageFlowStore` with atomic binding-aware compare-and-consume semantics. `RedisMcpUsageFlowStore` is the provided implementation for this flow-state role.

Stateless transport therefore does **not** mean stateless accounting. The goal is to avoid session affinity while retaining the authoritative state required to preserve transactional invariants.

## Resume-state safety matrix

| Invariant | Existing mechanism | Proof |
| --- | --- | --- |
| Integrity-verified wire state | The wrapper only accepts the decoded object returned by the MCP server `requestState.verify` hook; raw client-controlled strings fail closed. | `packages/mcp/src/index.test.ts` rejects raw unverified `requestState`. |
| Principal / tenant / tool / args binding | Suspended state is bound to trusted `principalId`, optional `tenantId`, tool name, and a hash of the original args. | `McpUsageFlowStore.consume()` atomically compares the full binding; Memory and Redis tests preserve legitimate state on mismatch. |
| One reservation per logical operation | Only a state-less initial entry calls `control.reserve()`; a verified resume calls `control.resumeLease()` on trusted server-side lease state. | Current-protocol integration test observes one quote across two fresh MCP requests and two handler instances. |
| One-time resume | A matching flow token is removed atomically during consume. | Memory concurrent replay enters the application handler once; Redis contention permits one consumer. |
| Mismatch does not burn legitimate state | Compare-and-consume removes state only after the binding matches. | Memory principal-mismatch and Redis binding-mismatch tests can still consume with the legitimate binding afterward. |
| Ambiguous consume acknowledgement fails closed | A consume error is surfaced; the wrapper does not retry or re-enter application work. | Redis lost-consume-ACK test proves the committed consume cannot subsequently be reused. |
| Cost liability survives crash/abandonment | Initial metered work is marked liable before the application handler runs; resume reattaches to the already liable lease. | Abandoned suspended-flow test retains the conservative charge after expiry. |

These guarantees are coupled. In particular, replacing the shared flow claim with client-carried state alone would not by itself prove one-time consume or safe handling of a lost consume acknowledgement.

## Stateless-friendly MRTR decision

No new stateless MRTR resume mode is introduced by this proof.

The current design already achieves the deployment property that matters here: fresh protocol requests may land on different server instances without sticky MCP session affinity. It does so by keeping the minimum authoritative flow claim in shared server-side state.

A future stateless-friendly representation should only be adopted if it can demonstrate the same properties under concurrency and acknowledgement ambiguity:

- one reservation per logical operation;
- trusted principal / tenant / tool / args binding;
- one-time claim/consume;
- no blind handler re-entry after an ambiguous claim acknowledgement;
- unchanged cost-liable and crash-expiry behavior.

Until such a mechanism has a stronger proof than the existing shared compare-and-consume design, adding it would increase surface area without improving the accounting contract.

## Tasks remain separate

This work does not add first-class MCP Tasks support. Task lifetime, renewal, cancellation, abandonment, settlement, and worker-loss semantics must be defined as an accounting state machine before implementation claims are made.

Task/business-result replay also remains outside the usage ledger. Usage accounting may prove whether quota was reserved, became liable, and was settled; it must not become a generic workflow engine for replaying arbitrary business side effects.

See [Architecture](architecture.md) for the core failure semantics and [Roadmap](roadmap.md) for the remaining Tasks and MCP-native work.
