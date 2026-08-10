# @mcp-usage-control/mcp

> Pre-alpha. This workspace package is currently private and not published to npm.

## English

Adapter for `@modelcontextprotocol/server` v2 tool handlers. `protectTool()` surrounds a handler with usage admission, renewable lease heartbeat, conservative error settlement, and explicit settlement-failure handling.

- [MCP integration](../../docs/mcp-integration.md)
- [API reference](../../docs/api-reference.md)
- [Architecture](../../docs/architecture.md)

The application remains responsible for trusted principal derivation, authentication/authorization, and stable operation IDs.

## 日本語

`@modelcontextprotocol/server` v2 tool handler向けadapterです。`protectTool()` がhandlerをusage admission、renewable lease heartbeat、conservative error settlement、明示的なsettlement failure handlingでwrapします。

- [MCP integration](../../docs/mcp-integration.ja.md)
- [API reference](../../docs/api-reference.ja.md)
- [Architecture](../../docs/architecture.ja.md)

信頼できるprincipal derivation、authentication / authorization、stable operation IDはapplication側の責務です。