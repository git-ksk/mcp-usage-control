# Security Policy

[English](SECURITY.md) | [日本語](SECURITY.ja.md)

## Supported versions

Before the first public registry/GitHub release completes, only the latest `main` branch is supported. Release-candidate tags may exist during publication preparation and do not by themselves expand the support matrix.

After public releases begin, supported versions will be listed here explicitly.

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability that could enable quota bypass, double spending, unauthorized entitlement access, cross-tenant accounting access, replay abuse, inconsistent settlement, or a crash/failure path that turns incurred work into free usage.

Use GitHub's private vulnerability reporting for this repository when available. A useful report includes the affected commit/version, a minimal reproduction, expected invariant, observed behavior, relevant concurrency/retry/expiry/storage-failure conditions, impact, and any workaround.

Do not include unrelated production credentials, user data, access tokens, cookies, or secrets.

## Security-sensitive invariants

Changes touching the following areas require tests that demonstrate the invariant under duplicate and concurrent calls where applicable:

- admission and quota comparison;
- reservation creation;
- pending -> cost-liable activation;
- renewable lease / expiry recovery;
- process-crash recovery after execution starts;
- operation idempotency and tombstones;
- settlement and unused-unit release;
- success/tool-error/thrown-error cost classifiers;
- principal and tenant scoping;
- Redis atomicity and transaction-domain assumptions;
- ambiguous acknowledgement handling;
- storage failure behavior;
- user/model-visible denial messages;
- observability hooks and metadata redaction boundaries.

Production stores must not implement quota enforcement as separate `check` and `record` operations. Ambiguous storage failures should fail closed for new admission unless the application explicitly chooses and documents a different availability policy.

## Cost-liability boundary

A reservation starts pending and can be released on expiry only before the metered execution boundary is entered. Once `markLiable()` succeeds, expiry must not turn a process crash into a refund; the current reference behavior charges the full reservation.

The generic MCP adapter marks a lease cost-liable immediately before handler entry. This is intentionally conservative. Applications that move the liability boundary later must ensure the alternative cannot create a crash-after-cost quota bypass.

Cost-classification hooks are not trusted enforcement state. If `successUnits`, `toolErrorUnits`, or `errorUnits` throws or produces invalid units, the MCP adapter settles the full reservation before surfacing `UsageClassificationError`.

## Trust boundaries

`mcp-usage-control` does not authenticate callers. Applications must derive `Principal` from trusted authentication/authorization state and must not trust model- or user-supplied plan/tenant identifiers without verification.

`operationId` is an idempotency input, not a credential. It should be stable for retries of the same logical invocation and must not be treated as proof of identity.

`UsageDeniedError.reason` can contain internal policy information. The thrown message is intentionally generic so MCP SDK error conversion does not automatically expose that reason. Applications should map denial reasons to user-visible messages only through an explicit allowlist/safe translation.

The built-in MCP lease heartbeat is not provider-specific fencing. Applications that require immediate cancellation after lease loss must implement fencing/cancellation at the metered resource boundary.

## Observability boundary

`UsageObserver` is operational telemetry, not trusted enforcement state and not a durable financial ledger. Observer success/failure must never decide admission, release quota, or alter settlement.

Tool arguments and raw exception messages are not captured automatically. `operation.error.errorName` uses a bounded constructor class name rather than mutable `Error.name` or the exception message. Custom `metadata` is explicit opt-in and may receive the usage request; applications are responsible for not copying secrets, tokens, raw tool arguments, provider payloads, or unrestricted user content into it.

Runtime events can contain principal, tenant, operation, reservation, tool, and budget identifiers. Treat them as potentially sensitive/high-cardinality data. Do not use unique principal/operation/reservation/user-specific budget identifiers as metrics labels/tags. Apply retention/access controls appropriate to structured logs and traces.

Redis lazy recovery intentionally does not persist raw request identities solely to improve telemetry; its recovery events can therefore be aggregate-only. Observability loss must not be treated as evidence that enforcement did not occur.

## MCP multi-round flows

The v0.1 MCP adapter does not support v2 `input_required` multi-round tool flows. It rejects them explicitly. Do not work around this by generating a new operation ID for every round or by reusing a settled operation ID; either approach can defeat intended accounting semantics. Dedicated suspend/resume support must preserve idempotency and liability across rounds.

## Redis durability boundary

Redis Lua provides atomic transitions, not financial-ledger durability. Persistence, replication and failover settings can change whether acknowledged accounting state survives infrastructure failures.

Operators must choose Redis HA/persistence appropriate to their risk tolerance. If durable financial reconciliation is required, use a separate durable ledger/event path in addition to Redis enforcement state. A durability failure that can systematically restore spendable quota should be treated as security-sensitive.

## Secret handling

The project should never require contributors to commit secrets. Examples, tests, logs, issue templates, and documentation must use placeholders or synthetic identifiers.

Redis keys intentionally hash principal/operation/budget identifiers, but hashing is not encryption. Do not place secrets in identifiers, event metadata, or settlement outcome values.

## Disclosure

Please allow time to reproduce and assess a report before public disclosure. Once a fix is available, security-relevant release notes should explain affected versions, impact, and remediation without exposing unrelated private information.