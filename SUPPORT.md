# Support

[English](SUPPORT.md) | [日本語](SUPPORT.ja.md)

`mcp-usage-control` is an open-source project with a stable v1 baseline. Community support is best-effort and there is no commercial support SLA.

## Supported runtime

The supported runtime floor is **Node.js 22+**. CI and release-safety evidence cover Node.js 22 and 24. Node.js 20 reached upstream EOL and is not part of the supported or required CI contract.

## Find help

| Need | Where to go |
| --- | --- |
| First integration | [Getting started](docs/getting-started.md) and [MCP integration](docs/mcp-integration.md) |
| Unexpected accounting behavior | [Troubleshooting](docs/troubleshooting.md) |
| Storage or deployment problem | [Redis](docs/redis.md), [Cloudflare](docs/cloudflare.md), or [Firestore](docs/firestore.md) |
| Development and test setup | [Contributing](CONTRIBUTING.md) |
| Known issues or new reports | [GitHub issues](https://github.com/git-ksk/mcp-usage-control/issues) |

## Bug reports

Use the [bug-report template](https://github.com/git-ksk/mcp-usage-control/issues/new/choose). Include:

- Package versions or commit SHA, Node.js version, and package manager.
- The storage adapter, backend/client versions, and single- or multi-instance topology.
- A minimal reproduction and expected versus actual behavior.
- Relevant lifecycle steps: admission, liability, renewal, execution, and settlement.
- Whether it involves retries, concurrency, expiry, or a lost acknowledgement.
- Sanitized error details and which tests were run or skipped.

Do not include credentials, tokens, cookies, secret connection strings, raw production principal IDs, or private customer data. Use representative identifiers consistently so operation relationships remain understandable.

## Feature requests

Use the feature-request template. Describe the product use case, the required accounting behavior, and whether an integration adapter could solve it. A concrete example is more useful than an API proposal alone.

## Dependency advisories

Supported-line dependency and GitHub Actions advisories are triaged through the automated checks described in [SECURITY.md](SECURITY.md). Critical/high advisories should include the affected dependency/action, supported release impact, applicability/exploitability assessment, and safe target version when known.

## Security issues

Do not use a public issue for a vulnerability that could enable quota bypass, double spending, unauthorized access, cross-tenant leakage, or inconsistent settlement. Follow [SECURITY.md](SECURITY.md).

## Questions about current limitations

Known current limitations and boundaries include:

- the public API/name freeze established before v1 is the compatibility baseline for the v1.0.x line;
- npm packages are published, while every future registry publication remains separately authorized through the manual OIDC Trusted Publishing workflow;
- stable first-class MCP Tasks wire/runtime integration remains deferred while the upstream surface is experimental;
- scalar operation reconciliation is supported by Memory, Redis, Firestore, and Cloudflare; vector initial-reserve reconciliation is supported by Memory, Redis, and Firestore, while Cloudflare remains an explicit fail-closed vector exception;
- strict provider-specific fencing after lease loss is outside the generic core;
- billing, payment, authentication, and analytics backends are not built into core.

If a question is answered by one of these boundaries, an issue may still be useful when it identifies a concrete documentation gap or proposes a scoped adapter.
