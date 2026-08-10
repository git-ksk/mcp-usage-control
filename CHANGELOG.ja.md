# Changelog

[English](CHANGELOG.md) | [日本語](CHANGELOG.ja.md)

主なproject changeをここへ記録します。現在はpre-alphaで、最初のpackage releaseはまだ公開していません。

## Unreleased

### Added

- provider-neutralな `@mcp-usage-control/core` usage-control contract。
- explicit settlementを使うatomic reserve-before-execute lifecycle。
- `markLiable()` によるpending -> cost-liable lease transition。
- renewable reservation lease / renewal API。
- execution開始後crashでfull reservationを保守的に維持するrecovery。
- concurrency / idempotency / liability test付きin-memory reference store。
- `@modelcontextprotocol/server` v2 single-round tool向け `@mcp-usage-control/mcp` adapter。
- normal result、`{ isError: true }` tool error、thrown errorを区別するMCP-aware classification。
- cost classifier failure / invalid units時のconservative full settlementと `UsageClassificationError`。
- ambiguous settlement向け `UsageSettlementError`。
- 現在未対応のMCP v2 `input_required` multi-round result向け `UnsupportedMcpUsageFlowError`。
- Redis-side Lua transitionを使うproduction-oriented `@mcp-usage-control/redis` adapter。
- application `Date.now()` ではなくRedis server timeによるlease / tombstone判定。
- state-dependent Redis expiry recovery / bounded idempotency tombstone。
- Redis Cluster compatibleなsingle-hash-slot transaction domain。
- 実Redisによるcrash recovery、application clock非依存、ambiguous ACK fault injection test。
- 公式MCP SDK v2 `Client + createMcpHandler` in-process protocol integration test。
- 英日project / architecture / Redis / integration / API / security / support / contribution / release documentation。
- bilingual GitHub Issue form / Pull Request template。

### Changed

- delimiter ambiguityを避けるためoperation key inputをhash/string storage前にtuple encode。
- `UsageDeniedError` は詳細 `.reason` をprogrammaticに保持しつつ、MCPへの意図しない露出を避けるためhuman-readable messageをgeneric化。
- cost-liable lease expiryはreserved unitsをreleaseせずconservative charge。
- Redis lease timingのauthorityをapplication instanceではなくRedis serverへ移動。
- Redis docsでLua atomicityとpersistence / failover durabilityを分離し、lazy cleanup backlogも明記。
- release gateにcrash semantics、MCP result semantics、protocol integration coverage、`input_required` support decisionを追加。

### Known pre-alpha limitations

- 1 reservationにつき1 budget。atomic multi-budget admissionはv0.1向けに予定。
- MCP v2 `input_required` multi-round suspend/resume accountingは未実装。
- principal / tenant / tool idempotency scopingは確定作業中。
- package名 / public APIは変更される可能性あり。
- workspace packageはprivate / unpublished。
- `pnpm-lock.yaml` は未commit。frozen reproducible installはv0.1 release gate。
- generic lease renewalはlease loss後のprovider-specific fencingを提供しない。
- Redis atomicityはfinancial-ledger durabilityを意味しない。

## Release entries

tagged release開始後はrelease date、breaking change、invariant change、storage/migration note、supported runtime dependencyを各entryへ含めます。詳しくは [Release policy](docs/releasing.ja.md) を参照してください。