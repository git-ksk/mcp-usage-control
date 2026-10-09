# Operator decision guide: denied and ambiguous MCP usage operations

[日本語](operation-recovery-playbook.ja.md)

This guide covers **what to do next**, not a new recovery API. The [reconciliation contract](operation-reconciliation.md) defines authoritative read-only status; the [incident-response runbook](incident-response.md) covers containment and restoring an accounting domain. The [MCP integration guide](mcp-integration.md) describes single- and multi-round execution. No usage telemetry counter, MCP request ID, log, or HTTP status can authorize a refund or a replay.

## Start with evidence, not retry

1. **Contain** new metered operations in the affected identity/domain if accounting or ownership is uncertain; do not silently allow unmetered work.
2. Record the phase and the *trusted* tenant, principal, tool, logical operation ID, original budget keys/dimensions and reserved units (use access-controlled incident records, **never raw IDs as metric labels or public logs**). Record Store kind, schema/runtime version, observed ACK/error, and time domain.
3. Distinguish **definite refusal/no dispatch**, **ambiguous acknowledgement**, and **read-only authoritative reconciliation**. A timeout or thrown exception does **not** prove that the Store rolled back or that no upstream work was incurred.
4. Read-only reconcile only when the selected Store and operation mode support it. Treat backend failure, unknown binding, missing capability, stale retention, or mismatched identity as **indeterminate / fail closed**. Never invent a new operation ID to escape `duplicate_operation`.
5. Escalate to the application owner for provider evidence, authenticated identity, business-effect result recovery, safe fencing and—if justified—an auditable accounting correction. The usage library is not a billing/refund system.

## Phase / decision matrix

| Phase or observation | Proof / safe next action | Forbidden shortcut |
| --- | --- | --- |
| Policy quote explicitly denies | No admission and no paid handler entry. Fix trusted policy/entitlement input before a **new intentional** operation. | Bypass the policy by sending a new ID for the rejected operation. |
| Quota `quota_exceeded` or retained `duplicate_operation` | No new paid handler entry for that denied call. Inspect all participating budgets or recover the *application* response from its own idempotency system. | Treat `duplicate_operation` as a replayed success/result. |
| Initial reserve transport error / ACK lost | The reserve might have committed. Pause dispatch; when available, reconcile with exact trusted scalar/vector quote topology and ID. | Blind second reserve, generated replacement ID, or assume `absent` means safe replay. |
| `markLiable()` error / ACK lost **before handler entry** | Handler has not run on this wrapper path, but liability transition may already have committed. Preserve lease identity and treat accounting state as uncertain; seek authoritative evidence and application-managed recovery. | Assume `pending`, refund zero, or start work against an unproven lease. |
| Progressive/vector growth ACK lost | The growth might have committed. Preserve growth cursor and exact operation/reservation identity; use only the provider's documented exact-replay/reconciliation boundary, otherwise fail closed. | Repeat an arbitrary growth amount or advance to paid work assuming the top-up failed. |
| Automatic `renew()` ACK lost | An `onLeaseRenewalState: uncertain` signal is **advisory**: may have renewed despite lost ACK. Application/provider must decide whether to fence or pause further exposure; a later `confirmed` event is not universal proof of upstream worker ownership. | Treat callback events as the authoritative Store clock or safely retry arbitrary paid work. |
| Handler returned `isError: true`, threw, or was interrupted after liability | Such client-visible errors do not prove zero provider cost. Charge/retain the reserved maximum unless **reliable evidence** supports a lower actual amount; use the wrapper's conservative default. | Automatic `settle(0)` or refund merely because MCP returned an error. |
| `settle()` ACK lost / `UsageSettlementError` | Settlement may have committed. Record both the business result and ambiguous accounting outcome, inspect supported read-only status, and escalate if indeterminate. | Run another settlement with a different outcome, replay handler, or start a fresh quota operation. |
| MCP `input_required` suspend/one-time flow claim ACK lost | Verified request-state plus server-side atomic compare-and-consume are authoritative; lost consume ACK means one-time token **may be spent**. Fail closed and recover business result separately. | Re-enter handler from same/raw client token or disable request-state integrity checks. |
| Store outage, corrupt record, binding mismatch, unsupported reconciliation | Indeterminate. Contain cost-bearing dispatch and restore compatible Store connectivity; follow incident runbook if persisted data may be affected. | Unmetered allow, delete reservations, reset the accounting domain, or rewrite schema markers. |

**Error visibility:** An official MCP client can receive `isError` and sanitized tool text even when the server-side wrapper raised `UsageDeniedError`, `UsageClassificationError`, or `UsageSettlementError`. A wire-level error is **not** the same proof as the server's local phase/status or an authoritative Store read. Do not leak raw exception objects, policies, tenant IDs, budget keys or secrets into client-visible errors.

## Read-only reconciliation: supported scope

| Store | Scalar initial reserve | Vector initial reserve | Operational limit |
| --- | --- | --- | --- |
| Memory | Yes | Yes | Process-local; restart loses retained state; `absent` after restart is not historical evidence. |
| Redis | Yes | Yes | Server `TIME` plus read-only Lua; shared atomic budget transaction domain must remain one cluster hash slot. Redis persistence/HA is deployment-specific. |
| Firestore | Yes | Yes | Read-only transactions; expiry classification requires bounded/synchronized host clocks; hot budget documents can cause contention. |
| Cloudflare Durable Objects | Yes, via authenticated remote scalar lookup | **No**; vector initial-reserve ACK ambiguity remains fail-closed | One DO is one SQLite atomic transaction domain; do not infer vector parity from scalar endpoints or assume any platform-overload observation. |

An authoritative read can report `active/pending`, `active/liable`, `expired/pending`, `expired/liable`, or `settled`. They are **observations**, not independent permission to replay business effects. `active/pending` is potentially resumable *only if the application separately proves metered work did not start and can reattach to the valid trusted lease*. `active/liable` and `expired/liable` never authorize replay or refund. A retained `settled` tombstone terminates the accounting operation. `absent` only means no state retained **now**, particularly unreliable after retention expiry or Memory restart. A store read error or unsupported capability remains indeterminate. See [operation reconciliation](operation-reconciliation.md) for exact input and invariant definitions.

## Worked example A: reserve ACK disappeared

- Client planned a non-destructive report using authenticated tenant/principal, `tool=report`, logical action ID `report-001`, scalar maximum 5, budget `tenant-A:2026-10` and its applicable limit. The application sends exactly that trusted quote identity to `reserve()`.
- The network times out. **Do not dispatch the paid report** or use `report-002` to obtain another reservation. First check Store health and whether the selected Store can read-only reconcile scalar initial-reserve status.
- If the exact read proves `active/pending`, the application must **also** prove no other worker started the report and can reattach safely to the original lease. If it proves `active/liable`, `expired/liable`, or `settled`, never re-execute it. If `absent` appears after retention or the Store responds with an error/unknown binding, stop: the result is indeterminate for replay decisions.
- For a **vector** initial reserve in Cloudflare, no equivalent read-only remote reconciliation is available; do not reuse the scalar helper as a substitute. Escalate with sanitized evidence and keep the operation fenced.

## Worked example B: handler finished, settle ACK disappeared

- An admitted report has already passed `markLiable()` and returned a business result. The application knows an actual cost of 3 out of 5 reserved units and calls `settle(3, 'success')`; the Store commits (or may have) but the response is lost.
- Preserve the application result in its own result/idempotency store and mark the **accounting outcome** ambiguous. The SDK may deliver an `isError` response to the client even when the report finished; that does not undo provider cost.
- Inspect the exact trusted operation via supported read-only reconciliation: retained `settled` means terminal; `active/liable` means potentially still charge-bearing and requires operator/provider-specific recovery. A transport failure or non-matching/missing result is indeterminate. **Never** run a second paid report or reflexively settle zero because the client reported failure.
- Decisions to compensate a customer require auditable application billing/provider evidence and do not follow automatically from non-authoritative observer counters.

## Related workflows

- [Runnable local MCP server + client](../examples/mcp-protect-tool/README.md) — normal/denied and conservative-cost demonstrations, not production authorization.
- [MCP logical operation identity](mcp-operation-identity.md) — action IDs vs per-dispatch random IDs; no weak transport dedup.
- [Operational telemetry](operational-usability.md) — best-effort `UsageOperationalMonitor`, scoped quota projection and pure threshold helpers are not authoritative balances.
- [Provider rollback and incident containment](incident-response.md) — never delete/rewrite live accounting state without compatible-domain recovery evidence.
