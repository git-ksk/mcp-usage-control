# @mcp-usage-control/mcp

> Pre-alpha. This workspace package is currently private and not published to npm.

## English

Adapter for `@modelcontextprotocol/server` v2 **single-round** tool handlers. `protectTool()` surrounds a handler with usage admission, cost-liable activation, renewable lease heartbeat, MCP-aware result classification, conservative fallback charging, and explicit settlement-failure handling.

It distinguishes normal success, MCP `{ isError: true }`, and thrown errors. If a cost classifier fails or returns invalid units, the full reservation is settled before `UsageClassificationError` is surfaced.

MCP v2 `input_required` multi-round flows are intentionally unsupported until reservation suspend/resume semantics are implemented; the wrapper rejects them explicitly rather than silently mis-accounting retries/rounds.

- [MCP integration](../../docs/mcp-integration.md)
- [API reference](../../docs/api-reference.md)
- [Architecture](../../docs/architecture.md)

The application remains responsible for trusted principal derivation, authentication/authorization, stable logical operation IDs, and provider-specific fencing after lease loss.

## 日本語

`@modelcontextprotocol/server` v2の **single-round** tool handler向けadapterです。`protectTool()` がusage admission、cost-liable activation、renewable lease heartbeat、MCP-aware result classification、conservative fallback charge、明示的なsettlement failure handlingでhandlerをwrapします。

normal success、MCP `{ isError: true }`、thrown errorを区別します。cost classifierが失敗またはinvalid unitsを返した場合はfull reservationをsettleした後 `UsageClassificationError` を表面化します。

MCP v2 `input_required` multi-round flowはreservation suspend/resume semantics実装まで意図的に未対応です。retry / roundをsilentに誤accountingせず明示的にrejectします。

- [MCP integration](../../docs/mcp-integration.ja.md)
- [API reference](../../docs/api-reference.ja.md)
- [Architecture](../../docs/architecture.ja.md)

信頼できるprincipal derivation、authentication / authorization、stable logical operation ID、lease loss後のprovider-specific fencingはapplication側の責務です。