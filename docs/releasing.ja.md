# Release policy

[English](releasing.md) | [日本語](releasing.ja.md)

`mcp-usage-control` は現在pre-alphaです。repositoryはpublicですが、package名とpublic contractを意図的にreviewするまではworkspace packageを `private: true` のまま維持します。

## v0.1より前

最初のv0.1 tagまでは次の方針です。

- supported development lineは `main` のみです。
- public TypeScript APIはdeprecation periodなしで変更される可能性があります。
- package名も変更される可能性があります。
- 特定tagを明記していないドキュメントはcurrent `main` behaviorを説明します。
- accounting invariantを変更するPRではmigration上の影響を説明します。

未publishのworkspace package名をstableなnpm contractとして扱わないでください。

## v0.1 release gate

最初のregistry releaseは、少なくとも次を完了してから行います。

- atomic multi-budget admissionのcontractが意図的にreviewされている。
- idempotency / expiry semanticsがdocumentedかつtestedである。
- core / MCP / Redis package名をnpm上で確認している。
- `pnpm-lock.yaml` をcommitし、CIでfrozen lockfileを使う。
- package `files` / exports metadataをpack smoke testで確認する。
- 可能な範囲でrelease provenance / trusted publishingを設定する。
- CIでlong-lived npm tokenを不要にする。
- English / Japanese user documentationがtagged codeと一致している。

## Versioning

1.0より前もSemantic Versioningを使用しますが、pre-1.0ではminor releaseにbreaking API changeが含まれる可能性があります。

目安は次のとおりです。

- patch: intended public contractを維持するfix。
- minor: new feature、および1.0より前の意図的なbreaking API change。
- major: 1.0以降のcompatibility boundary向け。

pre-1.0 minorであってもbreaking changeはrelease noteで明確に示します。

## Release note

各tagged releaseでは次をまとめます。

- user-visible feature / fix
- safety / accounting invariantの変更
- breaking API / configuration change
- storage schema / migration上の考慮点
- supported Node.js / MCP SDK / Redis version
- known limitation

secret、token、connection string、production identifier、非公開incident detailをrelease artifactへ含めないでください。

## Security fix

quota bypass、double spending、unauthorized entitlement access、inconsistent settlementにつながるvulnerabilityは [SECURITY.ja.md](../SECURITY.ja.md) に従って扱います。詳細なexploit informationを公開する前にdisclosureを調整してください。