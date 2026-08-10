# Cloudflare SQLite schema migration

`mcp-usage-control-cloudflare` は、usage-control用Durable Objectのtransaction domainごとにSQLite schema versionを管理します。

## 現在のschema

現在のschema versionは **1** です。

v1には次が含まれます。

- `budgets`
- `reservations`
- `reservations_active_expiry`
- `reservations_tombstone_expiry`
- schema versionを1行で保持する内部metadata table `usage_control_schema`

schema metadataはadapter内部状態です。application codeから変更しないでください。

## 起動時の動作

schema initializationは、public Durable Object runtimeがusage-control RPCを処理し始める前に、Durable Object storageの同期transaction内で実行します。

fresh databaseではv1 table / indexを作成し、最後にschema version `1` を記録します。

versioning導入前のv0.1で作成されたdatabaseでは、既存 `budgets` / `reservations` のcolumn layoutとaccounting constraintがv1と一致することを検証してからv1としてadoptします。既存のquota/accounting rowは書き換えません。v1 indexが欠けている場合は、quota balanceを変更しないため再作成できます。

initializationはretry-safeです。途中で例外が発生した場合はschema transactionをrollbackし、Durable Objectはusage enforcementを開始しません。

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
