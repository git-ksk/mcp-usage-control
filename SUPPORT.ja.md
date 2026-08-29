# Support

[English](SUPPORT.md) | [日本語](SUPPORT.ja.md)

`mcp-usage-control` は現在pre-v1のopen-source projectです。community supportはbest-effortで、commercial support SLAはありません。

## Supported runtime

v1のsupported runtime floorは **Node.js 22+** です。Node.js 20はupstream EOL済みで、supported v1 runtime contractには含めません。現在のbranch protectionがlegacyな `test (20)` checkをrequiredとしているため、repositoryではNode 20 CI jobを一時的にcompatibility-only evidenceとして残します。このjobがgreenでもNode 20 supportを意味しません。

## Issueを開く前に

次を確認してください。

- [Getting started](docs/getting-started.ja.md)
- [MCP integration](docs/mcp-integration.ja.md)
- [Architecture](docs/architecture.ja.md)
- [Redis adapter](docs/redis.ja.md)
- 既存のGitHub Issue

local developmentではNode.js 22以上を使い、次を実行してください。

```console
pnpm install
pnpm check
```

Redis関連のproblemでは、Redis versionと、concurrency、retry、expiry、network/storage failureのどの条件で再現するかを記載してください。

## Bug report

bug-report Issue templateを使用してください。次を含めると調査しやすくなります。

- commit SHA / version
- Node.js version
- storage adapterと、必要ならRedis version
- minimal reproduction
- expected / actual behavior
- duplicate call、concurrency、retry、lease expiry、settlementとの関係
- sanitize済みlog / error message

credential、token、cookie、secretを含むconnection string、raw production principal ID、private customer dataを含めないでください。

## Feature request

feature-request templateを使用し、use case、維持すべきsafety invariant、その変更がcoreとadapterのどちらに属するべきかを説明してください。

## Dependency advisory

supported lineのdependency / GitHub Actions advisoryは [SECURITY.ja.md](SECURITY.ja.md) のautomated check / triage policyで扱います。Critical/Highではaffected dependency/action、supported releaseへのimpact、applicability / exploitability判断、判明していればsafe target versionを記録します。

## Security issue

quota bypass、double spending、unauthorized access、cross-tenant leakage、inconsistent settlementにつながるvulnerabilityにはpublic Issueを使用しないでください。[SECURITY.ja.md](SECURITY.ja.md) に従ってください。

## Current limitationについて

既知のpre-v1 limitationには次があります。

- public API / name freezeはolder source releaseから暗黙に仮定せず、v0.11 lineで完了させる
- npm registry publicationは#6の明示authorization付きfirst publishまでdeferred
- stableなfirst-class MCP Tasks wire/runtime integrationはupstream surfaceがexperimentalな間deferred
- generic operation reconciliationはscalar-onlyで、vector initial-reserve ambiguityは別proofがない限りfail closed
- lease loss後の厳密なprovider-specific fencingはgeneric coreの責務外
- billing、payment、authentication、analytics backendをcoreへ内蔵しない

これらのboundaryに関する質問でも、具体的なdocumentation gapを示す場合や、scopeの明確なadapter提案であればIssueは有用です。
