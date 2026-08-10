# mcp-usage-control-mcp

MCP TypeScript SDK v2 adapter for `mcp-usage-control`.

> **Current distribution status:** this package is not published to npm yet. Use the repository checkout or locally packed `mcp-usage-control` + `mcp-usage-control-mcp` tarballs. See [Use from source / local tarballs](../../docs/using-from-source.md) / [日本語](../../docs/using-from-source.ja.md).

## English

`protectTool()` wraps **single-round** `@modelcontextprotocol/server` v2 tool handlers with admission, cost-liable activation, lease heartbeat, MCP-aware result classification, and explicit settlement.

For a tool with no input schema, set `noInput: true`. For input-schema tools, omit it. The adapter normalizes the SDK no-input callback/runtime shape without guessing whether `{}` is real input.

It distinguishes normal success, `{ isError: true }`, and thrown errors. Invalid/throwing cost classifiers cause the full reservation to be settled before `UsageClassificationError` is surfaced. Ambiguous settlement failures are surfaced as `UsageSettlementError` and are not blindly retried.

**v0.1 intentionally does not support MCP v2 `input_required` multi-round flows.** Such a result is conservatively settled and rejected with `UnsupportedMcpUsageFlowError` until suspend/resume semantics are implemented (issue #14).

- [Current source/tarball usage](../../docs/using-from-source.md)
- [MCP integration](../../docs/mcp-integration.md)
- [API reference](../../docs/api-reference.md)
- [Architecture](../../docs/architecture.md)

The application remains responsible for trusted principal/tenant derivation, authentication/authorization, retry-stable logical operation IDs, and provider-specific fencing after lease loss.

## 日本語

`protectTool()` は `@modelcontextprotocol/server` v2の **single-round** tool handlerをusage admission、cost-liable activation、lease heartbeat、MCP-aware result classification、explicit settlementでwrapします。

input schemaがないtoolでは `noInput: true` を指定し、input schemaありでは省略します。SDKのno-input callback / runtime shapeをnormalizeしますが、`{}` がreal inputかどうかを推測しません。

normal success、`{ isError: true }`、thrown errorを区別します。classifierがthrow / invalid unitsを返した場合はfull reservationをsettleしてから `UsageClassificationError` を表面化します。ambiguous settlement failureは `UsageSettlementError` として表面化しblind retryしません。

**v0.1はMCP v2 `input_required` multi-round flowを意図的に未対応とします。** 該当resultは保守的にsettleした後 `UnsupportedMcpUsageFlowError` でrejectし、suspend/resume semanticsはIssue #14で追跡します。

- [現在のsource / tarball利用手順](../../docs/using-from-source.ja.md)
- [MCP integration](../../docs/mcp-integration.ja.md)
- [API reference](../../docs/api-reference.ja.md)
- [Architecture](../../docs/architecture.ja.md)

trustedなprincipal / tenant derivation、authentication / authorization、retry-stable logical operation ID、lease loss後のprovider-specific fencingはapplication側の責務です。
