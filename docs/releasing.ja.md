# Release policy

[English](releasing.md) | [日本語](releasing.ja.md)

`mcp-usage-control` は現在pre-alphaです。repositoryはpublicですが、package名とpublic contractを意図的にreviewするまでworkspace packageは `private: true` のままです。

## v0.1前

最初のtagged v0.1 releaseまでは次の方針です。

- supportするdevelopment lineは `main` のみ。
- public TypeScript APIはdeprecation periodなしで変更される場合があります。
- package名も変更される可能性があります。
- documentationはtagを明示しない限りcurrent `main` behaviorを説明します。
- accounting invariant変更はPull Requestにmigration noteを含めます。

unpublished workspace package nameをstable npm contractのように扱わないでください。

## v0.1 release gate

最初のregistry releaseは少なくとも次が完了するまで実施しません。

- atomic multi-budget admissionがintentionally reviewedなall-or-nothing contractを持つ。
- idempotency、operation scope、tombstone、cancellation、expiry semanticsがdocument / test済み。
- pending -> cost-liable -> settled transitionとexecution開始後crash recoveryをreference store / Redis testでcover。
- MCP normal success、`{ isError: true }`、thrown error、classifier failure、settlement ambiguityをwrapper testと公式SDK client/handler integration pathの両方でcover。
- MCP v2 `input_required` にreal reservation suspend/resume supportが入るか、意図的に確定したsupport boundaryをdocument。
- Redis server-time expiry semanticsとdurability limitationをdocument。
- core / MCP / Redis package名をnpm上で確認。
- `pnpm-lock.yaml` をcommitしCIをfrozen lockfile化。
- package `files` / exports metadataをpack smoke testで確認。
- 可能な範囲でrelease provenance / trusted publishingを設定。
- CIでlong-lived npm tokenを不要にする。
- tagged codeと英日user documentationを一致させる。

## Versioning

1.0前もSemantic Versioningを使いますが、pre-1.0 minor releaseにbreaking API changeが含まれる可能性があります。

- patch: intended public contractを維持するfix。
- minor: feature追加、および1.0前のintentional breaking API change。
- major: 1.0以降のcompatibility boundary向け。

pre-1.0 minorでもbreaking changeはrelease noteで目立つ形で明記します。

## Release notes

各tagged releaseではuser-visible feature/fix、safety/accounting invariant変更、breaking API/configuration変更、storage schema/migration考慮、supported Node.js / MCP SDK / Redis version、known limitationを要約します。

release artifactへsecret、token、connection string、production identifier、private incident detailを含めません。

## Security fixes

quota bypass、double spending、unauthorized entitlement access、crash-after-cost refund、inconsistent settlementにつながる脆弱性は [SECURITY.ja.md](../SECURITY.ja.md) に従い、詳細exploit公開前にdisclosureを調整します。