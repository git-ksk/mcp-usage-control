# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

projectの主要な変更をここへ記録します。現在はpre-alphaで、まだ最初のpackage releaseをpublishしていません。

## Unreleased

### Added

- provider-neutralな `@mcp-usage-control/core` usage-control contract
- explicit settlementを使うatomic reserve-before-execute lifecycle
- renewable reservation lease / lease renewal API
- concurrency / idempotency test付きin-memory reference store
- `@modelcontextprotocol/server` v2向け `@mcp-usage-control/mcp` adapter
- 長時間handler向けdefault MCP lease heartbeat
- conservative error settlementとsuccess / error unit classification hook
- ambiguous settlement stateを明示する `UsageSettlementError`
- Redis-side Lua transitionを使うproduction `@mcp-usage-control/redis` adapter
- Redis expiry recovery / bounded idempotency tombstone
- Redis Cluster-compatibleなsingle-hash-slot transaction domain
- 実Redis integration test / ambiguous acknowledgement fault-injection test
- project、architecture、Redis、integration、API、security、support、contribution、releaseの英日documentation
- bilingual GitHub Issue form / Pull Request template

### Changed

- reservationをfixed TTLではなくrenewable leaseとして扱うよう変更
- MCP execution failureとsettlement failureを分離し、ambiguous settlementを盲目的にretryしないよう変更
- Redis key nameへraw principal / operation / budget identifierを埋め込まず、storage前にhash化するよう変更

### Known pre-alpha limitations

- 1 reservationにつき1 budget。atomic multi-budget admissionはv0.1までの予定
- package名 / public APIは変更される可能性あり
- workspace packageはprivate / unpublished
- generic lease renewalはlease loss後のprovider-specific fencingを提供しない

## Release entry

tagged release開始後は、各entryへrelease date、breaking change、invariant change、storage / migration note、supported runtime dependencyを記載します。詳しくは [Release policy](docs/releasing.ja.md) を参照してください。