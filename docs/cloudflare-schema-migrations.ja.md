# Cloudflare SQLite schema migration

`mcp-usage-control-cloudflare`はusage-control Durable Object transaction domainごとにSQLite schema versionを管理します。

## 現在のschema

現在のschema versionは **3** です。

schema v3は`budgets`、`reservations`、v2 `reservation_growth`、v3 `reservation_vectors`、active/tombstone expiry index、single-row `usage_control_schema` markerを持ちます。v1の`budgets` / `reservations` column layoutはv3まで変更しません。

## 起動とmigration

initializationはusage-control RPC開始前にDurable Object storage transaction内で同期実行します。retry-safeで、例外時はschema transactionをrollbackしenforcementを開始しません。

対応path:

- fresh / pre-versioning: v1をvalidate/adoptまたはcreate -> v2 `reservation_growth` -> v3 `reservation_vectors` -> v3 validate -> version 3
- marked v1: validate -> v2 -> v3 -> validate -> version 3
- marked v2: validate -> v3 -> validate -> version 3
- v3: exact supported layoutをvalidate
- future version: fail closed

additive migrationではexisting accounting rowを書き換えません。balanceを変えないv1 index欠損は再作成できます。

## v1 -> v2 progressive-growth migration

v2はv1 accounting tableを変更せず`reservation_growth`を追加します。upgrade前からあるreservationにはgrowth rowをbackfillせずfixedのまま、新しいgrowth-capable reservationだけadmissionとatomicにrowを作ります。quota balance / liability / expiry / settlement / tombstoneはrewriteしません。

## v2 -> v3 vector-metadata migration

v3は`reservation_vectors`（`reservation_id`、`dimensions_json`、optional `actual_dimensions_json`、optional `last_vector_growth_json`）だけを追加します。scalar reservationをbackfillせずbalance/lifecycleもrewriteしないためv1/v2 rowはscalarのままです。

新しいvector admissionはbase reservation identityとsidecarを同じ`transactionSync` boundaryで書きます。sidecarがper-dimension reserved totalを保持し、異種unitをscalar `reserved_units`へ変換しません。vector base rowのscalar `reserved_units = 0`はnon-accounting placeholderです。

schema version 3へmigration後はv2 binaryを同じdomainで使いません。rollbackはforward fixまたはseparate/explicitly restored domainを使い、`usage_control_schema.version`を手動で下げないでください。

## Fail-close条件

required accounting table欠損、column/constraint不一致、schema metadata不正、future version、deterministic registered migrationのないold versionではsilent reinitializeせずstartupを失敗させます。schema incompatibilityをunmetered executionへ変換しません。

## 将来schema change

直前versionからのexplicit deterministic migrationを追加し、schema transaction内でaccounting invariant維持、retry-safe、result validate、success後のみversion更新、fresh/upgrade/interruption/future-version test、merge前local workerd integrationを必須にします。

`CREATE TABLE IF NOT EXISTS`だけでdeclared migrationを代替しません。

実環境evidenceとrollback planningは[Cloudflare deployed E2E](cloudflare-deployed-e2e.ja.md)を参照してください。
