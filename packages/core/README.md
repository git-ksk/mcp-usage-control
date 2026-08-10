# @mcp-usage-control/core

> Pre-alpha. This workspace package is currently private and not published to npm.

## English

Provider- and MCP-independent usage-control primitives: policy quoting, atomic reservation contracts, pending -> cost-liable transitions, renewable leases, outcome-aware settlement, idempotency, and the in-memory reference store.

The intended lifecycle is:

```text
reserve -> markLiable -> execute -> settle
             ^             |
             |--- renew ---|
```

Pending expiry may release capacity; cost-liable expiry is conservative and retains the full reservation so a crash after execution starts cannot become a refund.

- [Getting started](../../docs/getting-started.md)
- [API reference](../../docs/api-reference.md)
- [Architecture](../../docs/architecture.md)

Keep authentication, billing providers, MCP SDKs, and storage-specific implementation details outside this package.

## 日本語

provider / MCP非依存のusage-control primitiveを提供します。policy quote、atomic reservation contract、pending -> cost-liable transition、renewable lease、outcome-aware settlement、idempotency、in-memory reference storeを含みます。

基本lifecycle:

```text
reserve -> markLiable -> execute -> settle
             ^             |
             |--- renew ---|
```

pending expiryはcapacityを解放できますが、cost-liable expiryはfull reservationを保守的に維持し、execution開始後のcrashがrefundになることを防ぎます。

- [Getting started](../../docs/getting-started.ja.md)
- [API reference](../../docs/api-reference.ja.md)
- [Architecture](../../docs/architecture.ja.md)

authentication、billing provider、MCP SDK、storage-specific implementation detailはこのpackageの責務外です。