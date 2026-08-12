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

## CI運用ルール

CIは、**安全性を落とさず、ドキュメント変更では重い処理をしない**ことを基本方針にします。

### Required check

mainのbranch protectionでは `test (20)` と `test (22)` をRequired checkとして扱います。

この2つのcheck名は運用上の契約です。workflow内のjob名やmatrix構成を変更してcheck名が変わる場合は、branch protection側も同じ運用変更として見直してください。check名だけを先に変更しないでください。

Required checkをworkflow全体の `paths-ignore` で止める構成は使いません。workflow自体が起動しないとRequired checkが生成されず、docs-only PRでもmergeできなくなる可能性があるためです。

### docs-only PR

次のどちらかだけを変更したPRはdocs-onlyとして扱います。

- `docs/**`
- 任意の階層にあるMarkdown (`*.md`)

すべての変更pathがこの条件に入る場合、`changes` jobでdocs-onlyと判定し、`test (20)` / `test (22)` 自体は実行します。ただし各jobでは軽量pathだけを成功させ、次の重い処理は省略します。

- repository checkout
- Node / pnpm setup
- dependency install
- Redis起動
- `pnpm check`
- public packageのpackと内容検査
- clean consumerへのtarball install

Required check名を残したまま中身だけ軽量化するのが、このrepoのdocs-only運用です。

### full CIへ切り替える条件

Markdown以外の変更が1つでも含まれる場合はfull CIを実行します。source、workflow、`package.json`、lockfile、configなどはすべてfull CI対象です。

変更差分の基準SHAを取得できない場合や、差分pathを正常に判定できない場合も、安全側に倒してfull CIを実行します。判定不能を理由にtestを省略しません。

`.github/workflows/ci.yml` 自体の変更もMarkdownではないため、必ずfull CIになります。

### Store固有のintegration workflow

CloudflareとFirestoreのintegration testは通常CIとは分離し、関係するpathだけで起動します。

- Cloudflare Integration: `packages/cloudflare/**`、`packages/core/**`、`.github/workflows/cloudflare-integration.yml`
- Firestore Integration: `packages/firestore/**`、`packages/core/**`、`.github/workflows/firestore-integration.yml`

Firestoreだけの変更でCloudflare Integrationを動かしたり、その逆をしたりしないのが原則です。一方、`packages/core/**` は両adapterの前提contractなので、core変更時は両integration workflowを意図的に実行します。

新しいStore adapterやintegration workflowを追加する場合も、adapter自身・依存する共有package・そのworkflow自身だけをtrigger対象にするのを基本とします。triggerを広げる場合は、依存関係上必要な理由をPRで説明してください。

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