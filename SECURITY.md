# Security Policy

[English](SECURITY.md) | [日本語](SECURITY.ja.md)

## Supported versions

This project is currently pre-alpha. Until the first tagged release, only the latest `main` branch is supported.

After tagged releases begin, supported versions will be listed here explicitly.

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability that could enable quota bypass, double spending, unauthorized entitlement access, cross-tenant accounting access, replay abuse, or inconsistent settlement.

Use GitHub's private vulnerability reporting for this repository when available. A useful report includes:

- affected commit or version;
- a minimal reproduction;
- the expected safety invariant;
- the observed behavior;
- whether concurrent calls, retries, expiry, or storage failures are required;
- impact and any known workaround.

Do not include unrelated production credentials, user data, access tokens, cookies, or secrets in a report.

## Security-sensitive invariants

Changes touching the following areas require tests that demonstrate the invariant under duplicate and concurrent calls where applicable:

- admission and quota comparison;
- reservation creation;
- renewable lease / expiry recovery;
- operation idempotency and tombstones;
- settlement and unused-unit release;
- principal and tenant scoping;
- Redis atomicity and transaction-domain assumptions;
- ambiguous acknowledgement handling;
- storage failure behavior.

Production stores must not implement quota enforcement as separate `check` and `record` operations. Ambiguous storage failures should fail closed for new admission unless the application explicitly chooses and documents a different availability policy.

## Trust boundaries

`mcp-usage-control` does not authenticate callers. Applications must derive `Principal` from trusted authentication/authorization state and must not trust model- or user-supplied plan/tenant identifiers without verification.

`operationId` is an idempotency input, not a credential. It should be stable for retries of the same logical invocation and must not be treated as proof of identity.

The built-in MCP lease heartbeat is not provider-specific fencing. Applications that require immediate cancellation after lease loss must implement fencing/cancellation at the metered resource boundary.

## Secret handling

The project should never require contributors to commit secrets. Examples, tests, logs, issue templates, and documentation must use placeholders or synthetic identifiers.

Redis keys intentionally hash principal/operation/budget identifiers, but hashing is not encryption. Do not place secrets in identifiers or settlement outcome values.

## Disclosure

Please allow time to reproduce and assess a report before public disclosure. Once a fix is available, security-relevant release notes should explain affected versions, impact, and remediation without exposing unrelated private information.