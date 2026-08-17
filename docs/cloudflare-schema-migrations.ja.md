# Cloudflare SQLite schema migration

`mcp-usage-control-cloudflare` は、usage-control用Durable Objectのtransaction domainごとにSQLite schema versionを管理します。

## 現在のschema

現在のschema versionは **2** です。

v2はv1 accounting layoutを維持し、progressive-growth metadata専用tableを1つ追加します。

- `budgets`
- `reservations`
- `reservation_growth`（`reservation_id`、current `growth_cursor`、latest replay metadata）
- `reservations_active_expiry`
- `reservations_tombstone_expiry`
- schema versionを1行で保持する内部metadata table `usage_control_schema`

v1の`budgets` / `reservations` column layoutは変更しません。

schema metadataはadapter内部状態です。application codeから変更しないでください。

## 起動時の動作

schema initializationは、public Durable Object runtimeがusage-control RPCを処理し始める前に、Durable Object storageの同期transaction内で実行します。

fresh databaseではv1 accounting table / indexを作成し、`reservation_growth`を追加してv2 layoutを検証後、schema version `2` を記録します。

versioning導入前のdatabaseでは既存`budgets` / `reservations`がexact v1 accounting layoutであることをvalidate / adoptしてからdeterministicなv1 -> v2 additive migrationを行います。explicit v1 databaseもv1 validate後に同じmigrationを実行します。既存`budgets` / `reservations` accounting rowは書き換えず、`reservation_growth`とschema-version markerだけを追加します。v1 index欠損はquota balanceを変更しないため再作成できます。

initializationはretry-safeです。途中で例外が発生した場合はschema transactionをrollbackし、Durable Objectはusage enforcementを開始しません。

## v1 -> v2 progressive-growth migration

v0.6 migrationは意図的にadditiveです。v1 accounting tableを変更せず`reservation_growth`だけを作成します。upgrade時点ですでに存在するreservationにはgrowth rowを作らないため、fixed reservationのままです。v0.6で新規admissionされたreservationだけ、reservationとatomicにgrowth rowを作成して`grow`へopt-inします。

これにより、callerが一度も受け取っていないgrowth cursorを既存operationへretroactiveに発行しません。migrationはquota balance、liability state、expiry timestamp、settlement state、tombstoneを一切rewriteしません。

schema version 2へmigration後は旧v1 binaryを同じdomainで起動できません。rollbackは`usage_control_schema.version`を手動で下げるのではなく、forward-fixまたは別domainで行います。

## Fail-closeする条件

次を検出した場合、silent repair / reinitializeはせず起動を失敗させます。

- 必須accounting tableが片方しか存在しない。
- 必須columnまたはaccounting constraintが期待するv1 layoutと異なる。
- schema metadataが不正。
- 保存されたschema versionがruntimeの対応versionより新しい。
- 保存されたschema versionが古く、明示的migration stepが登録されていない。

remote callerからはusage-control backend unavailableとして観測されます。application側は既存のfail-close方針を維持し、schema incompatibilityをunmetered fallbackへ変換しないでください。

## 将来のschema version追加

schemaを変更するreleaseでは、直前versionからの明示的かつdeterministicなmigration stepを追加してください。

migrationは次を満たします。

1. schema transaction内で実行する。
2. data変換中もquota/accounting invariantを維持する。
3. deployment中断後にstartupが再実行されても安全である。
4. migration後のtable / index / constraintを検証する。
5. migration成功後にのみ `usage_control_schema.version` を更新する。
6. fresh作成、upgrade、retry/中断、unsupported versionのunit testを追加する。
7. merge前にCloudflare workerd integration suiteを通す。

`CREATE TABLE IF NOT EXISTS` をdata/schema migrationの代替にしないでください。

## Deployment手順

schema-changing releaseを広くdeployする前に、次を実施します。

1. dedicated dogfood/test Worker + Durable Object domainへdeployする。
2. `reserve`、`markLiable`、`renew`、`settle`、expiry recovery、contention、retry/reconciliationを実行する。
3. schema/startup errorがbusiness `quota_exceeded` として扱われていないことを確認する。
4. usage-control Workerが起動できない場合もapplicationがfail-closeを維持することを確認する。
5. migrated domainが安定してからdeployment範囲を広げる。

通常の実Cloudflare E2E手順は [Cloudflare deployed E2E](cloudflare-deployed-e2e.ja.md) を参照してください。

## Rollbackの制約

今回の最初のversioning導入では、versioning前v0.1のaccounting tableをdata rewriteなしでv1としてadoptするため、既存balanceの破壊的変換はありません。

ただし、この性質を将来versionへ一般化してはいけません。今後のmigrationでcolumn、constraint、stored semanticsが変わった場合、古いbinaryがmigration後databaseを理解できない可能性があります。schema-changing releaseごとにbinary rollback可否を明記し、必要ならdeploy前にforward-fixまたは明示的data rollback手順を定義してください。

古いruntimeを強制起動するために保存済みschema versionを手動で下げないでください。
