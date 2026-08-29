# Security Policy

[English](SECURITY.md) | [日本語](SECURITY.ja.md)

## Supported versions

The latest GitHub/source minor line is supported for security fixes. For this policy, **v0.12.x is the current released pre-v1 source baseline**; older v0.x source-release lines are superseded. npm registry publication is a separate operation and remains deferred even while the GitHub/source release is supported. The supported v1 runtime floor is **Node.js 22+**. Node.js 20 is EOL and any temporary Node 20 CI execution is compatibility-only evidence, not a supported-runtime claim.

## Dependency and workflow supply-chain maintenance

Dependabot update PRs cover npm/pnpm and GitHub Actions. Pull requests are checked for newly introduced high/critical vulnerable dependencies, and a scheduled repository audit checks the existing lockfile. Third-party GitHub Actions are pinned to immutable commit SHAs; update automation may propose newer pins, but review still requires the normal release-safety evidence.

Critical/high advisories affecting the supported source line are triaged as security issues. Critical issues should trigger immediate containment/release assessment; high issues should be fixed before the next affected release or explicitly documented as not exploitable/applicable. These are maintainer response priorities, not a commercial SLA.

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
- MCP multi-round suspend/resume binding and one-time consumption;
- Redis atomicity and transaction-domain assumptions;
- Firestore transaction and server-side authorization boundaries;
- ambiguous acknowledgement handling;
- storage failure behavior;
- user/model-visible denial messages;
- observability hooks and metadata redaction boundaries.

Production stores must not implement quota enforcement as separate `check` and `record` operations. Ambiguous storage failures should fail closed for new admission unless the application explicitly chooses and documents a different availability policy.

## Cost-liability boundary

A reservation starts pending and can be released on expiry only before the metered execution boundary is entered. Once `markLiable()` succeeds, expiry must not turn a process crash into a refund; the current reference behavior charges the full reservation.

The generic MCP adapters mark a lease cost-liable immediately before handler entry. This is intentionally conservative. Applications that move the liability boundary later must ensure the alternative cannot create a crash-after-cost quota bypass.

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

Prefer `projectUsageEvent()` when producing operational structured logs. Its default projection excludes identity fields, reservation/operation IDs, tool/budget identifiers, settlement outcome strings, and unrestricted application reason strings. Enabling projected metadata remains explicit opt-in and does not make caller-provided metadata safe automatically.

Redis lazy recovery intentionally does not persist raw request identities solely to improve telemetry; its recovery events can therefore be aggregate-only. Observability loss must not be treated as evidence that enforcement did not occur.

## MCP multi-round flows

`protectTool()` remains single-round and rejects v2 `input_required`. Applications that need suspend/resume accounting must opt in to `protectMultiRoundTool()`.

The wire `requestState` must be minted with an integrity-protection scheme that the MCP server verifies. The wrapper accepts only the already-decoded payload from the SDK verification hook; raw, malformed, or unverified state fails closed. `UsageLeaseResumeState` is trusted server-side state and must not be exposed to an untrusted client as a credential or bearer token.

Suspended flows are bound to principal, optional tenant, tool, and a hash of the original arguments. `McpUsageFlowStore.consume()` must compare that binding and consume a matching flow atomically. A mismatch must not consume the legitimate flow. `MemoryMcpUsageFlowStore` is process-local; horizontally scaled servers should use a durable store with atomic compare-and-consume semantics, such as `RedisMcpUsageFlowStore`.

The Redis MCP flow store uses binding-aware Lua operations and Redis server-time expiry. Missing, expired, replayed, or mismatched flows fail closed. Ambiguous or lost consume acknowledgements must also fail closed; callers must not generate a new operation ID and re-enter application work after an uncertain consume result.

Multi-round work is marked cost-liable before handler entry. Resume renews the existing reservation rather than reserving quota again. If a process disappears after claiming a flow, expiry conservatively retains the full reserved charge.

## Cloudflare remote-store boundary

The Cloudflare adapter's public HTTP gateway requires an application-defined authorization callback; it has no unauthenticated default. Non-local remote clients require HTTPS and embedded URL credentials are rejected. Timeout/lost-ack failures are ambiguous and must not be hidden by blind automatic retries.

The adapter hashes operation, budget, and settlement-outcome identifiers before the Cloudflare backend boundary and does not send tool arguments. Hashing is not encryption and does not make secret-bearing identifiers safe.

## Firestore store boundary

The Firestore adapter is server-side enforcement infrastructure. Applications must not grant untrusted clients direct write access to its budget/reservation collections or treat a configurable collection prefix as an authorization boundary.

Reserve, settlement, and expiry recovery update enforcement state through Firestore transactions. Expired pending reservations release capacity; expired liable reservations retain the conservative charge. Lease expiry uses host-clock timestamps with a configurable grace period, so deployments must account for clock skew and contention on heavily shared budget documents.

Budget keys and operation identity tuples are SHA-256 hashed before becoming Firestore document IDs. Hashing reduces accidental identifier disclosure but is not encryption; do not place secrets in identifiers. Firestore IAM/Security Rules and server credential handling remain application/deployment responsibilities.

## Redis durability boundary

Redis Lua provides atomic transitions, not financial-ledger durability. Persistence, replication and failover settings can change whether acknowledged accounting state survives infrastructure failures.

Operators must choose Redis HA/persistence appropriate to their risk tolerance. If durable financial reconciliation is required, use a separate durable ledger/event path in addition to Redis enforcement state. A durability failure that can systematically restore spendable quota should be treated as security-sensitive.

## Secret handling

The project should never require contributors to commit secrets. Examples, tests, logs, issue templates, and documentation must use placeholders or synthetic identifiers.

Redis keys intentionally hash principal/operation/budget identifiers, but hashing is not encryption. Do not place secrets in identifiers, event metadata, or settlement outcome values.

## Incident containment

For a known-bad released version, use [the emergency containment/hotfix runbook](docs/incident-response.md). Do not clear or downgrade authoritative provider state as an improvised security workaround.

## Disclosure

Please allow time to reproduce and assess a report before public disclosure. Once a fix is available, security-relevant release notes should explain affected versions, impact, and remediation without exposing unrelated private information.
