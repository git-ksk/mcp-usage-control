# MCP Tasks accounting

[English](mcp-tasks-accounting.md) | [日本語](mcp-tasks-accounting.ja.md)

This document defines the accounting contract for long-running MCP Tasks without turning `UsageStore` into a task scheduler or workflow engine.

The contract is intentionally protocol-adapter independent. It defines how one logical metered operation maps onto the existing usage lifecycle:

```text
quote -> atomic reserve -> pending -> cost-liable -> renew -> settle
```

The MCP task state machine and the usage-accounting state machine are related, but they are **not the same state machine**.

## Protocol baseline and support boundary

Reviewed 2026-10-10: the repository targets the stable MCP `2026-07-28` protocol and tests the official TypeScript SDK v2 **minimum/current compatible peer matrix** (not a claim that the client and server are both pinned to SDK 2.0.0).

The Tasks feature is provided as the `io.modelcontextprotocol/tasks` extension. Its **2026-07-28 schema snapshot is marked Stable** (separate from the independently evolving Draft), defining task-backed `tools/call`, `tasks/get`, `tasks/update`, and `tasks/cancel`, with `working`, `input_required`, `completed`, `failed`, and `cancelled` statuses.

The TypeScript SDK v2 core no longer treats the old 2025-11-25 `tasks/*` vocabulary as modern core protocol. As of the reviewed upstream `@modelcontextprotocol/ext-tasks@0.2.2`, the extension package documents **requester/client lifecycle APIs** and a **2025-11-25 Tasks receiver**; stable 2026-07-28 **server/receiver** support cannot be inferred from schema maturity. This project defines and proves **accounting semantics**, but does **not** advertise a first-class official Tasks server adapter. [#272](https://github.com/git-ksk/mcp-usage-control/issues/272) requires a live official-SDK/extension interop spike; [#275](https://github.com/git-ksk/mcp-usage-control/issues/275) is gated on its outcome.

Primary references used for this decision:

- MCP `2026-07-28` release notes: <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
- TypeScript SDK `2026-07-28` support notes: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md>
- Tasks extension repository/specification (stable 2026-07-28 snapshot): <https://github.com/modelcontextprotocol/ext-tasks>
- Official current TypeScript extension package scope: <https://modelcontextprotocol.github.io/ext-tasks/typescript/>

This is a compatibility boundary, not an accounting limitation. The existing core lease primitives are sufficient to enforce the state machine below.

## Two state machines, one logical operation

MCP exposes task status to describe deferred business execution:

```text
working <-> input_required -> completed | failed | cancelled
```

Usage accounting remains:

```text
absent
  |
  | atomic admission
  v
pending
  |
  | immediately before metered/business execution may incur cost
  v
cost-liable
  |
  | renew while authoritative execution remains active
  v
settled
```

A task status transition does not by itself authorize an accounting transition. In particular:

- `working` does not prove cost has been incurred;
- `input_required` does not create a new usage operation;
- a successful `tasks/cancel` acknowledgement does not prove work stopped or that zero cost was incurred;
- task TTL expiry or task deletion does not prove that a usage reservation is refundable;
- `completed` with a tool result containing `isError: true` is still a completed MCP Task, but accounting should classify the actual metered outcome conservatively.

## State-transition contract

| Event | Required accounting action | Failure rule |
| --- | --- | --- |
| Initial task-backed `tools/call` admission | Quote and atomically reserve **once** for the stable logical `operationId`. The task ID is not a second operation ID. | Ambiguous reserve acknowledgement must be reconciled or replayed under the same logical operation; never create an unrelated second reservation. |
| Task durably created / handle returned | No automatic liability transition. The reservation may remain `pending` while work is queued and has not crossed the metered boundary. | A lost task-create/response acknowledgement must not cause blind business re-execution. Business task creation needs its own idempotency/reconciliation boundary. |
| Worker is about to enter the metered execution boundary | Call `markLiable()` **before** the work that may incur cost. | If `markLiable()` fails or its acknowledgement is ambiguous, do not start the metered work. Fail closed. A committed-but-unacknowledged liability transition may later conservatively retain the charge. |
| Task remains `working` | Renew the same lease while the authoritative task controller still considers the operation active. | Renewal failure means the usage lease can no longer be assumed valid. Do not obtain a fresh reservation and blindly continue/replay work. |
| Task becomes `input_required` | Keep the same reservation and lease. Continue server-side renewal for the period the task is intentionally retained. `tasks/update` must resume the same logical operation without policy quote/reserve. | Client polling or input delivery is not lease authority. Lost/duplicate input responses are task/business-state concerns, not reasons to create another usage reservation. |
| Task `completed` | Settle once using proved actual units when available. | If actual usage cannot be determined after execution may have started, settle conservatively up to the reserved amount; do not refund from protocol status alone. |
| Task `failed` | If failure is proved pre-cost, zero settlement is allowed. If the lease is liable, settle proved actual usage or the conservative full reservation by default. | A JSON-RPC/task error is not evidence of zero provider cost. |
| `tasks/cancel` request acknowledged | **Do not settle or refund merely because the cancel request was acknowledged.** Cancellation is cooperative/eventually consistent and the task may still complete normally. | Wait for authoritative terminal execution state or let lease expiry apply. |
| Task reaches authoritative `cancelled` before liability | Settle zero with an explicit pre-execution cancellation outcome. | Only safe when the server can prove the metered boundary was never crossed. |
| Task reaches authoritative `cancelled` after liability | Settle proved actual usage, otherwise conservatively retain the full reservation. | Never infer zero usage from `cancelled`. |
| Client stops polling / disconnects | No accounting transition by itself. | The server-side task controller owns lease renewal and terminal settlement. Client liveness must not control refunds. |
| Worker/process crashes before liability | Stop renewing; pending expiry releases capacity according to the existing store contract. | No new reservation is required merely to recover accounting state. |
| Worker/process crashes after liability | Stop renewing if no authoritative worker can safely continue; liable expiry retains the full reservation. | Do not blindly replay the business operation. A replacement worker may continue only under a separate business-side claim/idempotency guarantee. |
| Settlement acknowledgement is lost | Replay only the **identical** settlement when the store supports the contract's idempotent tombstone semantics. | A conflicting settlement fails closed. Do not issue a different settlement to regain availability. |
| Reconciliation discovers a final external/provider result | Apply the same terminal settlement that would have been applied synchronously. | Reconciliation may determine usage; it must not become a second admission path or rewrite an already-conflicting settlement. |

## One reservation per logical operation

The stable accounting identity remains:

```text
(tenantId, principal.id, tool, operationId)
```

A task ID identifies protocol/business task state. It does **not** replace `operationId`, authorize usage, or create a new accounting scope.

The expected lifecycle is:

```text
tools/call
  -> reserve(logical operation) once
  -> durable business task created
  -> markLiable() before metered work
  -> renew() while active / waiting for required input
  -> settle() once at authoritative terminal accounting state

tasks/get      -> read task state only
tasks/update   -> continue same operation; no reserve
tasks/cancel   -> cancellation intent only; no refund on ACK
```

A retried original request after an ambiguous response must use the same logical operation identity. Duplicate-operation protection may prevent a second reservation, but it does **not** make arbitrary business task creation safe to replay. The business task system must independently deduplicate or reconcile task creation/results.

## Liability boundary

The safest generic boundary is unchanged from synchronous MCP tools: `markLiable()` immediately before application/provider execution may incur metered cost.

Task creation may happen before that boundary. This is useful when a task is durably queued but has not started expensive work yet. Conversely, a server may create a task only after some metered setup work; in that design it must mark the reservation liable before that work begins.

The accounting layer must not infer liability from the MCP status string. `working` means the task is operationally active, not that a provider billable boundary has definitely been crossed.

## Lease renewal and Task TTL are separate

Three time concepts must remain distinct:

1. **usage lease TTL** — bounds how long an active accounting reservation may remain without authoritative renewal;
2. **MCP task TTL** — controls how long the task protocol record may be retained or considered usable;
3. **settled idempotency tombstone TTL** — retains duplicate-operation and identical-settlement replay protection after settlement.

None may silently substitute for another.

Renewal is driven by the server-side component that owns authoritative execution, not by `tasks/get` polling. A quiet client must not cause a valid long-running task to lose its usage lease, and frequent polling must not keep an abandoned worker's reservation alive indefinitely.

When a task is intentionally retained in `input_required`, the server may keep renewing the same lease. Deployments should bound that retention period according to product policy so abandoned user-input waits do not reserve quota forever.

## Cancellation semantics

The Tasks extension defines cancellation as cooperative and eventually consistent. Therefore a successful `tasks/cancel` acknowledgement means only that cancellation intent was accepted; it is **not** a proof of terminal `cancelled` state or zero work.

The accounting consequences are deliberately conservative:

```text
cancel ACK
  -> no settlement yet
  -> authoritative execution outcome
       |- proved pre-cost cancelled -> settle 0
       |- liable + known usage      -> settle known usage
       `- liable + unknown usage    -> settle full reservation / conservative expiry
```

This prevents cancellation races from becoming a refund primitive.

## Crash, abandonment, and safe continuation

The usage store owns quota reservation, liability, renewal, settlement, and expiry recovery. It does **not** own worker assignment, task queues, result storage, or exactly-once business execution.

After a worker crash:

- accounting state may be reattached from trusted server-side `UsageLeaseResumeState` when the deployment can prove that continuing the same business operation is safe;
- the right to reattach accounting state is not itself permission to replay business work;
- a task scheduler may use its own fencing token, job claim, provider idempotency key, or result reconciliation to decide whether another worker may proceed;
- if safe continuation cannot be proved, stop renewal and let the existing pending/liability expiry semantics resolve accounting conservatively.

This separation is intentional. Moving task queue/result state into `UsageStore` would make the store a generic workflow engine and widen the correctness surface without strengthening quota enforcement.

## Ambiguous acknowledgements

The existing failure-safe rules apply unchanged:

- reserve ACK ambiguity: preserve stable logical identity and reconcile; no unrelated second reserve;
- liability ACK ambiguity: do not enter metered work without a confirmed safe transition; if the store committed but the ACK was lost, conservative expiry is acceptable;
- renew ACK ambiguity: do not assume a lease extension succeeded when it cannot be established;
- settlement ACK ambiguity: identical settlement replay may be idempotent; conflicting settlement must fail;
- task/business ACK ambiguity: resolve in the task/business layer and do not use accounting state as permission to blindly repeat side effects.

## Horizontal scale

MCP transport requests may land on different server instances. Usage accounting still requires authoritative shared state for production horizontal scale.

For v1, the project keeps the current design:

- shared/durable `UsageStore` for reservation/liability/renewal/settlement;
- shared/durable one-time compare-and-consume state for MRTR (`McpUsageFlowStore`) where multi-round request flow is used;
- a separate task backend when Tasks are implemented, responsible for durable task state and business execution ownership.

A sticky MCP session is not required for accounting. A task router may use protocol routing hints such as the task ID, but that is a task-placement concern, not a reason to weaken the shared accounting contract.

## Implementation status

**Accounting contract: defined and covered by core proof tests.**

`packages/core/src/task-accounting-proof.test.ts` exercises the existing primitives against the safety-critical Task cases: renewal through long-running/input wait, pre-liability cancellation, cancellation after liability, pending/liable worker crash expiry, and idempotent/conflicting terminal settlement.

**First-class MCP Tasks server-side adapter: deferred until the official receiver interoperability gate #272 passes; #275 is conditional.**

No new Core runtime API is required to express the accounting lifecycle today. A stable optional Tasks adapter should be added only after testing the official 2026-07-28 **receiver** SDK/extension surface, not by inferring server support from the stable schema alone. Maintain existing accounting semantics, request-state integrity, application-owned task result storage, cancellation/fencing boundaries, and supported Node/peer constraints.

This is not a current accounting feature blocker. [#272](https://github.com/git-ksk/mcp-usage-control/issues/272) records the v1.3 compatibility decision; [#275](https://github.com/git-ksk/mcp-usage-control/issues/275) remains a conditional v1.4 candidate. If upstream receiver interoperability is missing, defer implementation and do **not** advertise first-class Tasks server support.
