# Release policy

[English](releasing.md) | [日本語](releasing.ja.md)

## Release packages

v0.1 release lineでは、最初のregistry publishが承認された時点で3つのpublic npm packageを公開できるよう準備します。

- `mcp-usage-control`
- `mcp-usage-control-mcp`
- `mcp-usage-control-redis`

公開完了までは [Source / local tarballから使う](using-from-source.ja.md) のrepository checkout / local tarball手順を使います。v0.1.xでは3 packageを同じversionでreleaseします。

## Versioning

Semantic Versioningを使います。pre-1.0ではminor releaseにintentional breaking API changeを含む場合があります。

- patch: intended public contractを維持するfix。
- minor: feature追加、および1.0前のintentional breaking API change。
- major: 1.0以降のcompatibility boundary。

pre-1.0 minorでもbreaking changeはrelease notesで明示します。

## v0.1.0 gate

最初のreleaseは次を満たした場合のみreadyとします。

- Memory / Redis storeでmulti-budget admissionがall-or-nothing。
- idempotency scope / bounded tombstone retentionをdocument / test済み。
- pending -> cost-liable -> settledのcrash semanticsをtest済み。
- MCP success、`isError`、thrown error、classifier failure、settlement ambiguityをdirect testと公式SDK pathの両方でcover。
- `input_required` にv0.1の明示的support boundaryがある。
- provider-neutral observabilityがbest-effortで、返されたPromiseをawaitせず、secret-consciousかつenforcement stateから隔離されている。
- observerの同期処理がinline / lightweightであることとreplay deduplication semanticsをdocument済み。
- Memory / Redis expiry recovery observabilityとhigh-cardinality guidanceをdocument / test済み。
- Redis server-time behavior / durability limitationをdocument済み。
- package name / exports / filesを確認済み。
- `pnpm-lock.yaml` commit済み、CIは `--frozen-lockfile`。
- package tarballをCIでsmoke testし、workspace protocol dependencyがpublish artifactへ残らない。
- tagged codeと英日user documentationが一致。
- npm credentialをrepository file / logへ残さないrelease mechanism。

## Release procedure

1. package version、changelog、英日docsを更新。
2. Node.js 20 / 22 + 実Redis + frozen dependencyでCI。
3. public packageをpackしtarball contentを検証。
4. release PRを `main` へmerge。
5. test済みexact commitへ `vX.Y.Z` tag。
6. dependency順にnpm publish: core -> MCP -> Redis。
7. 同tagからGitHub Releaseを作成。
8. clean consumer projectからregistry metadata / installをverify。

npm package configurationが対応できる場合はGitHub-hosted runnerのnpm Trusted Publishing / OIDCを優先します。long-lived npm tokenをrepository file、log、release artifactへ入れません。

## Release notes

各releaseで次を明記します。

- user-visible feature / fix。
- accounting / security invariant変更。
- breaking API / configuration change。
- Redis schema / migration consideration。
- supported Node.js / MCP SDK / Redis version。
- 特にMCP multi-round supportを含むknown limitation。
- npm package name / GitHub tag。

## Redis schema

Redis storage layoutはimplementation detailですが、既存enforcement stateを持つdeploymentへ影響し得ます。v0.1以降にexisting stateを安全にreadできないschema changeを行う場合はmigration / reset noteを目立つ形で付けます。

## Security fixes

quota bypass、double spending、unauthorized entitlement access、cross-tenant replay、crash-after-cost refund、inconsistent settlement、sensitive observability leakageにつながる脆弱性は [SECURITY.ja.md](../SECURITY.ja.md) に従い、exploit detail公開前にdisclosureを調整します。
