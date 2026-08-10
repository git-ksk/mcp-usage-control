# Architecture

## Scope

`mcp-usage-control` owns the runtime boundary between an authenticated principal and a metered tool execution:

```text
identity -> entitlement/policy -> quote -> reserve -> tool -> settle
```

It does not own authentication, subscription billing, payment collection, dashboards, or upstream API pricing.

## Why reserve before execution

A `check -> execute -> record` design has a time-of-check/time-of-use race. When several agent tool calls arrive concurrently, each can observe the same remaining balance and all start before any usage is recorded.

The store therefore exposes a single `reserve()` operation. A production store must make quota comparison, duplicate-operation detection, and reservation creation atomic.

## Why settlement is not rollback

A tool can fail after an upstream resource was consumed. Automatically refunding every exception creates an incentive and an abuse path where a caller repeatedly triggers post-cost failures.

The runtime uses explicit settlement:

- success: normally settle the actual consumed units;
- pre-cost failure: the application may settle zero;
- post-cost failure: settle the units already incurred;
- unclassified failure: MCP adapter defaults to the full reservation.

The v0.1 contract requires `actualUnits <= reservedUnits`. Dynamic-cost tools should reserve their safe maximum before execution, then release the unused portion at settlement.

## Idempotency

`operationId` is supplied by the application. The store scopes it to the principal and rejects a duplicate reservation. This protects against concurrent retry and accidental duplicate dispatch.

The in-memory reference store keeps settled operation IDs for the process lifetime. The production Redis design will separate reservation TTL from a longer idempotency tombstone policy.

Settlement itself is idempotent when the same `actualUnits` and `outcome` are repeated. A conflicting second settlement is rejected.

## Store contract

`UsageStore` is intentionally independent of MCP and storage vendors. The in-memory implementation is for tests and local development.

The Redis adapter must provide:

- atomic reserve using Redis-side scripting/functions;
- atomic settlement and unused-unit release;
- reservation expiry recovery;
- duplicate operation protection;
- bounded idempotency retention;
- no fail-open behavior on ambiguous storage failures by default.

## MCP adapter

`@mcp-usage-control/mcp` targets the public `@modelcontextprotocol/server` v2 API. It only depends on the core abstraction and uses the SDK's public `ServerContext` type.

The core package never imports the MCP SDK. This keeps accounting semantics reusable and isolates protocol/SDK churn to the adapter package.

## Future multi-budget admission

A production SaaS commonly needs several constraints at once, for example:

- user monthly credits;
- user daily credits;
- tenant monthly credits;
- burst/concurrency controls.

The current pre-alpha store has one budget per reservation. Multi-budget atomic admission is planned before v0.1 so all applicable budgets succeed or fail as one transaction.
