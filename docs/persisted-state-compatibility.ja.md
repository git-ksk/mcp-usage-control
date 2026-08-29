# 永続状態の互換性とロールバック

`mcp-usage-control` では provider の永続状態を enforcement-authoritative として扱います。package SemVer は、accounting state を再解釈・破棄・暗黙再作成してよいという意味ではありません。

この文書は v0.11 -> v1 に向けた built-in provider の互換境界を固定します。

## 全 durable provider 共通ルール

1. unknown / newer / malformed / structurally incompatible な authoritative state は fail closed にする。空の quota domain として扱わない。
2. upgrade で state を変換する場合は、reservation / liability / settlement / replay / budget invariant を保つ deterministic で test 済みの path に限定する。
3. rollback は、rollback 先 binary が newer binary の書き得る persisted shape をすべて理解できる場合のみ supported とする。
4. provider namespace / domain selector の変更は別 accounting state を選ぶ操作であり、migration ではなく accounting reset である。
5. backup / restore は authoritative domain を1つに保つ。独立に write された2つの copy を後から1つの ledger のように merge しない。

## 互換性マトリクス

| Provider | v0.11/v1 persisted generation | 最新 pre-v1 -> v1 | v1 が newer state を見た場合 | rollback 境界 |
| --- | --- | --- | --- | --- |
| Redis | reservation JSON `schemaVersion: 1`。pre-v1 の exact unversioned record も継続対応 | in-place。bulk rewrite なし | targeted mutation / cleanup mutation より前に fail closed | conditional。domain 内に存在する全 record field を理解する runtime に限る |
| Firestore | reservation / budget document `schemaVersion: 1` | in-place。collection rewrite なし | unsupported document version は fail closed | conditional。既に write 済みの全 v1 document shape を rollback 先が理解する場合のみ |
| Cloudflare DO SQLite | `usage_control_schema.version = 3` | 既に v3 なら in-place。旧 supported schema は登録 migration で forward | future version は startup fail closed | stored version より max schema が低い runtime への rollback は unsupported |

## Redis

### v1 record generation

新規 scalar / vector reservation record には numeric `schemaVersion: 1` を付与します。

pre-v1 Redis record には schema marker がありませんでした。v1 は marker absent を supported legacy generation として扱い、既存 reservation / liability / growth metadata / vector metadata / settlement / replay tombstone を bulk migration なしで継続利用します。

background / startup rewrite は行いません。pre-v1 record は lifecycle が終わるまで unversioned のままでも構いません。migration pass 自体が第2の accounting transition になることを避けるためです。

### future-version fail-closed

schema version が存在し、値が `1` 以外の reservation は v1 Redis script では unsupported です。

対象 lifecycle operation は reservation / budget state を変更する前に reject します。reserve 時の lazy cleanup では、対象 cleanup batch 内の reservation / tombstone record をすべて先に preflight し、その後に release / retain / delete / budget mutation を実行します。Redis Lua は runtime error 発生時に、それ以前の write を rollback しないため、この順序が必要です。

unsupported active record を参照する duplicate-operation mapping は conservative に扱い、2本目の reservation を作るのではなく admission を block したままにします。

### rollback

`schemaVersion: 1` 自体は最新 pre-v1 JSON shape に対する additive field ですが、任意の古い release へ downgrade して安全という意味ではありません。古い release は progressive growth / vector record / reconciliation metadata などを知らない可能性があります。

rollback は、選択した旧 release が Redis domain 内に既に存在する全 record mode / lifecycle metadata を理解すると明示的に確認できる場合のみ supported です。それ以外は compatible backup を restore するか roll forward します。

旧 binary に無理に読ませるために `schemaVersion` を削除・変更してはいけません。

### domain reset 境界

`prefix` と `hashTag` が Redis accounting domain を選択します。どちらかを変更すると別 key 群を参照するため、その runtime から見える quota / reservation / replay history は reset されます。通常 deployment 変更ではなく明示的な operator-driven reset/rekey として扱います。

## Firestore

Firestore budget / reservation document は `schemaVersion: 1` を使用します。reader は別 version を absent / zero-used として扱わず reject します。

v0.11 -> v1 では collection / document の rewrite は行いません。現在の scalar / vector lifecycle data は v1 document contract 内で継続利用します。

rollback は conditional です。rollback 先 runtime が既に write 済みの全 document mode / optional lifecycle field を理解する必要があります。`schemaVersion: 1` は persisted generation marker であり、過去の全 binary が generation 内の全 field を理解することを保証するものではありません。

`collectionPrefix` は authoritative collection pair を選びます。変更すると fresh accounting state を選ぶため、別途 offline で invariant-preserving migration を設計していない限り quota / replay reset です。

reservation だけ、または budget だけを copy してはいけません。両者で1つの accounting domain です。

## Cloudflare Durable Objects SQLite

Cloudflare は明示 SQL schema marker と deterministic migration を持ちます。current schema v3 は v1 base accounting table に progressive-growth / vector sidecar を追加した構成です。

initialization は current layout を validate し、登録済み forward migration を1つの `transactionSync` 境界で実行します。future schema version / malformed metadata / incompatible table shape は unmetered traffic を serve せず startup を停止します。

stored schema より max supported schema が低い binary は rollback target にできません。特に domain が v3 へ migration 済みなら、`usage_control_schema.version` を手作業で下げるのは禁止です。roll forward するか、明示的に compatible な domain snapshot を restore します。

Durable Object class / namespace / binding を変更して fresh storage domain に request を送る操作は、application config が他は同じでも accounting reset です。

migration 詳細は [Cloudflare SQLite schema migrations](cloudflare-schema-migrations.ja.md) を参照してください。

## Upgrade 手順

通常の v0.11/v1 deployment では次を行います。

1. provider domain selector (`prefix` / `hashTag`, `collectionPrefix`, Durable Object namespace/class binding) を特定する。
2. target release が現在 stored generation を support することを確認する。
3. rollback requirement がある場合は provider-native backup / snapshot を保持する。
4. domain selector を変えずに deploy する。
5. release policy が要求する provider integration / health evidence を確認する。
6. runtime が unsupported persisted state を報告した場合は billable dispatch を止め、compatibility problem を解消する。automatic recovery として authoritative state を clear / recreate しない。

backup / diagnostic でも通常の privacy boundary を守り、migration evidence のためだけに raw prompt / tool argument / credential / user PII を追加保存しません。

## 将来の schema change

future persisted generation を追加する場合、merge 前に最低限以下を定義します。

- old -> new upgrade path
- old binary が new write を安全に読めるか
- interruption / retry behavior
- future-version fail-closed evidence
- rollback または明示 no-rollback policy
- fresh-domain/reset implication
- transformation を cover する provider integration test

これらが未確定なら、その schema change は release-ready ではありません。
