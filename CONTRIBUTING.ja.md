# Contributing

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md)

`mcp-usage-control` へのcontributionありがとうございます。

このprojectではquota / accounting behaviorをcorrectness・security上の重要領域として扱います。reservation、liability、expiry、retry、classification、settlementの小さな変更でもoversubscriptionやunder-accountingにつながるため、該当変更には明示的なinvariant testが必要です。

## Development

必要環境:

- Node.js 20+
- pnpm 10
- Redis integration behaviorを再現する場合はDockerまたはlocal Redis 7

```console
pnpm install
pnpm check
```

CIではNode.js 20 / 22、実Redis 7、MCP SDK v2 protocol integration behaviorをtestします。

## Repository layout

```text
packages/core    provider / MCP非依存のusage-control contract
packages/mcp     @modelcontextprotocol/server v2 integration
packages/redis   production-oriented Redis UsageStore adapter
docs             architecture / user guide
```

abstraction自体に必要でない限り、storage、protocol、billing、provider-specific concernを `core` に入れないでください。

## Design rules

- `core` はMCP SDKやbilling/payment providerから独立させる。
- production storeでquota checkとreservation作成を分離しない。
- `pending -> cost-liable -> settled` の区別を維持する。execution開始後のcrashをsilent refundにしない。
- すべてのerrorを自動refundしない。settlementは実際に発生したmetered costを反映する。
- cost-classification hookはfallible / untrusted extension pointとして扱い、conservative fallbackを維持する。
- operation IDはidempotency inputでありauthentication credentialではない。
- active reservationはrenewable leaseとして扱い、初回TTLだけで正常な長時間workを回収しない。
- ambiguous writeをblind retryしない。
- storage errorを黙ってallowへ変換しない。
- input schemaがないMCP toolではruntime `{}` から推測せず、明示的な `noInput: true` modeを要求する。SDKのpublic no-input callback typeと実dispatch behaviorの両方をprotocol testでcoverする。
- input schemaがあるMCP toolではvalidated `(args, ctx)` behaviorを維持する。
- MCP `{ isError: true }` をnormal successとして扱わない。
- explicitなmulti-round suspend/resume accounting semanticsなしに `input_required` supportを追加しない。
- Redis atomicityとdurability claimを分離する。
- provider-specific behaviorをcoreへ入れるよりsmall adapterを優先する。

safety invariantを変更する前に [Architecture](docs/architecture.ja.md) を確認してください。

## Pull Request

PRはfocusedに保ち、problem、affected invariant、testしたfailure/concurrency case、API/storage/documentation impact、migration/compatibility impactを説明してください。

behavior changeではallow / deny pathをcoverします。必要に応じてduplicate/retry、concurrency、pending vs cost-liable expiry、lease renewal/loss、process-crash recovery、classifier failure、ambiguous ACK、MCP protocol-level behaviorもtestしてください。

MCP adapter behaviorを変更する場合、direct unit testに加えてSDK semanticsが関係する箇所は公式SDK `Client + createMcpHandler` integration testも追加してください。

## Documentation

user-facing documentationは英語・日本語で維持します。behavior、configuration、public API、operational warningを変更した場合は、可能な限り同じPRで両言語を更新してください。

code identifierは英語を正とします。package名、API symbol、Redis key、error class名、configuration field名は翻訳しません。

documentation indexは [docs/README.ja.md](docs/README.ja.md) です。

## Commit / PR hygiene

- credential、token、cookie、secretを含むconnection string、production identifierをcommitしない。
- correctness-sensitive changeへ無関係なformat/refactorを混ぜない。
- invariantを緩める前にtestを追加する。
- hidden fallbackより明示的なfailure behaviorを優先する。
- contribution branchからpackageをpublishしない。

## Security issueの報告

quota bypass、double spending、unauthorized entitlement access、crash-after-cost refund、cross-tenant access、inconsistent settlementにつながるvulnerabilityはpublic Issueへ投稿せず [SECURITY.ja.md](SECURITY.ja.md) に従ってください。

## Code of Conduct

projectへの参加は [CODE_OF_CONDUCT.ja.md](CODE_OF_CONDUCT.ja.md) に従います。