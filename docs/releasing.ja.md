# Release policy

[English](releasing.md) | [日本語](releasing.ja.md)

## Release surfaces

GitHub/source releaseとnpm registry publishは別工程とします。

v0.1 lineには5つのpublish可能なnpm packageがあります。

- `mcp-usage-control`
- `mcp-usage-control-mcp`
- `mcp-usage-control-redis`
- `mcp-usage-control-cloudflare`
- `mcp-usage-control-firestore`

npm publishを明示承認する前でもGitHub Releaseは作成できます。registry公開までは [Source / local tarballから使う](using-from-source.ja.md) のrepository checkout / local tarball手順を使います。

v0.1.xでは全packageを同じversionでreleaseします。

## Versioning

Semantic Versioningを使います。pre-1.0ではminor releaseにintentional breaking API changeを含む場合があります。

- patch: intended public contractを維持するfix。
- minor: feature追加、および1.0前のintentional breaking API change。
- major: 1.0以降のcompatibility boundary。

pre-1.0 minorでもbreaking changeはrelease notesで明示します。

## v0.1.x gate

v0.1.x GitHub/source releaseは、対象surfaceについて次を満たした場合のみreadyとします。

- 適用可能なMemory / Redis / Cloudflare / Firestore storeでmulti-budget admissionがall-or-nothing。
- idempotency scope / bounded tombstone retentionをdocument / test済み。
- pending -> cost-liable -> settledのcrash semanticsをtest済み。
- MCP success、`isError`、thrown error、classifier failure、settlement ambiguityをdirect testと公式SDK pathの両方でcover。
- `input_required` に明示的support boundaryまたはtest済みopt-in multi-round pathがある。
- provider-neutral observabilityがsecret-consciousでenforcement stateから隔離されている。
- Redis server-time behavior / durability limitationをdocument済み。
- Cloudflare Durable Objects + SQLite behavior、schema versioning、remote ACK ambiguity / reconciliation、gateway authentication、maintenance / pruning boundary、lazy cleanup / cost behaviorをdocument / test済み。
- Firestore transactional multi-budget behavior、shared document contention / hotspot risk、host-clock lease semantics、expiry recovery、server-client compatibilityをdocument / test済み。
- package name / exports / filesを確認済み。
- `pnpm-lock.yaml` commit済み、CIは `--frozen-lockfile`。
- npm-pack tarballをsmoke testし、workspace protocol dependencyがartifactへ残らない。
- clean-consumer importがpass。
- Cloudflareをlocal workerd、FirestoreをLocal Emulator Suiteでintegration testし、deployed dogfood要件はadapterごとに扱う。
- tagged codeと英日user documentationが一致。

## GitHub/source release procedure

1. package version、changelog、英日docsを更新。
2. Node.js 20 / 22 + 実Redis + frozen dependencyでCI。
3. 対象codeについてCloudflare workerd integrationとFirestore Emulator integrationを実行。
4. public packageをpackしtarball contentを検証。
5. release PRを `main` へmerge。
6. test済みexact commitへ `vX.Y.Z` tag。
7. 同tag / changelog entryからGitHub Releaseを作成。

`GitHub Release` workflowはnpm publishを行いません。

## npm publication procedure

npm publishは後日の明示的な別工程です。Git tag / GitHub Releaseが存在するだけでは実行しません。

1. npm package nameのavailability / ownershipを確認。
2. final public contract reviewを実施。
3. npm Trusted Publishingまたは必要に応じてone-time bootstrap credentialを設定・確認。
4. publish対象のGitHub Release / tagを確認。
5. `Publish npm` workflowをexplicit confirmation付きで手動実行。
6. dependency順にpublish: core -> MCP / Redis / Cloudflare / Firestore adapter。
7. clean consumer projectからregistry metadata / installをverify。

GitHub-hosted runnerではnpm Trusted Publishing / OIDCを優先します。long-lived npm tokenをrepository file、log、release artifactへ入れません。

## Release notes

各releaseで次を明記します。

- user-visible feature / fix。
- accounting / security invariant変更。
- breaking API / configuration change。
- Redis / Cloudflare / Firestore storage / migration consideration。
- supported Node.js / MCP SDK / Redis / Cloudflare / Firestore test/runtime version。
- multi-round flowやstore固有のcontention / time semanticsを含むknown limitation。
- npm publishを含むか、deferしているか。

## Storage schema

Redis / Cloudflare / Firestore storage layoutはimplementation detailですが、既存enforcement stateを持つdeploymentへ影響し得ます。v0.1以降にexisting stateを安全にreadできないschema changeを行う場合はmigration / reset noteを目立つ形で付けます。

## Security fixes

quota bypass、double spending、unauthorized entitlement access、cross-tenant replay、crash-after-cost refund、inconsistent settlement、unauthenticated remote-store access、sensitive observability leakageにつながる脆弱性は [SECURITY.ja.md](../SECURITY.ja.md) に従い、exploit detail公開前にdisclosureを調整します。
