# Contributing

[English](CONTRIBUTING.md) | [日本語](CONTRIBUTING.ja.md)

`mcp-usage-control` へのcontributionありがとうございます。

このprojectではquota / accounting behaviorをcorrectness・security上の重要領域として扱います。reservation、expiry、retry、settlementの小さな変更でもoversubscriptionやunder-accountingにつながるため、該当領域の変更には明示的なinvariant testが必要です。

## Development

必要環境:

- Node.js 20+
- pnpm 10
- Redis integration behaviorを再現する場合はDockerまたはlocal Redis 7

標準verification suite:

```console
pnpm install
pnpm check
```

CIではNode.js 20 / 22をtestし、Redis integration test用に実際のRedis 7 serviceを起動します。

## Repository layout

```text
packages/core    provider / MCP非依存のusage-control contract
packages/mcp     @modelcontextprotocol/server v2 integration
packages/redis   production Redis UsageStore adapter
docs             architecture / user guide
```

abstraction自体に本当に必要でない限り、storage、protocol、billing、provider-specific concernを `core` に入れないでください。

## Design rules

- `@mcp-usage-control/core` はMCP SDKやbilling/payment providerから独立させる。
- production storeでquota checkとreservation作成を分離しない。
- すべてのerrorを自動refundしない。settlementはmetered costが実際に発生したかを反映する。
- operation IDはidempotency inputとして扱い、authentication credentialとして扱わない。
- active reservationはrenewable leaseとして扱う。crash recoveryのための初回TTLだけを理由に正常な長時間workを回収しない。
- ambiguous settlement writeを盲目的にretryしない。
- storage errorを黙ってallowへ変換しない。
- semanticsを変更する場合は、対応するconcurrency、duplicate、expiry、retry、ambiguous failure testを追加する。
- provider-specific behaviorをcoreへ入れるよりsmall adapterを優先する。

safety invariantを変更する前に [Architecture](docs/architecture.ja.md) を確認してください。

## Pull Request

PRはfocusedに保ってください。descriptionでは次を説明します。

1. 何のproblemを解決するか。
2. どのusage / accounting invariantを変更または維持するか。
3. どのfailure / concurrency caseをtestしたか。
4. public API、storage state、documentationへの影響があるか。
5. migration / compatibilityへの影響があるか。

behavior changeではallowed / denied両pathをtestしてください。security-sensitive changeでは必要に応じてduplicate、concurrent、expiry、retry、storage failure caseもcoverしてください。

## Documentation

user-facing documentationは英語・日本語で維持します。behavior、configuration option、public API、operational warningを変更した場合は、可能な限り同じPRで両言語を更新してください。

code identifierは英語を正とします。package名、API symbol、Redis key、error class名、configuration field名は翻訳しません。

documentation indexは [docs/README.ja.md](docs/README.ja.md) です。

## Commit / PR hygiene

- credential、token、cookie、secretを含むconnection string、production identifierをcommitしない。
- correctness-sensitive changeで無関係なformat/refactorを混ぜない。
- invariantを緩める前にtestを追加する。
- hidden fallbackより明示的なfailure behaviorを優先する。
- contribution branchからpackageをpublishしない。

## Security issueの報告

quota bypass、double spending、unauthorized entitlement access、inconsistent settlementにつながるvulnerabilityをpublic Issueへ投稿しないでください。[SECURITY.ja.md](SECURITY.ja.md) に従ってください。

## Code of Conduct

projectへの参加は [CODE_OF_CONDUCT.ja.md](CODE_OF_CONDUCT.ja.md) に従います。