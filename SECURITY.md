# Security Policy

## Supported versions

This project is currently pre-alpha. Until the first tagged release, only the latest `main` branch is supported.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could enable quota bypass, double spending, unauthorized entitlement access, or inconsistent settlement.

Use GitHub's private vulnerability reporting for this repository when available. Include a minimal reproduction, affected commit/version, expected invariant, and observed behavior.

## Security-sensitive invariants

Changes touching the following areas require tests that demonstrate the invariant under duplicate and concurrent calls:

- admission and quota comparison;
- reservation creation;
- operation idempotency;
- settlement and release;
- TTL/expiry recovery;
- principal and tenant scoping;
- storage failure behavior.

Production stores must not implement quota enforcement as separate `check` and `record` operations. Ambiguous storage failures should fail closed unless the application explicitly chooses a different availability policy.
