# Known-bad release containment / emergency hotfix runbook

[English](incident-response.md) | [日本語](incident-response.ja.md)

release済みversionがusage enforcement、replay、settlement、authentication、persisted-state safetyを壊す可能性がある場合のrunbookです。[Persisted-state compatibility / rollback](persisted-state-compatibility.ja.md) のcontractを運用で使うもので、provider schema semanticsを再定義しません。

## 最初の原則: authoritative stateを触る前にcontainする

impactが不明な場合は、data repairより先に**新しいcost-bearing dispatchを停止またはgate**します。availabilityを戻す目的でcounterをclearしたり、accounting-domain selectorを変えたり、unmetered fallbackへ逃がしたりしません。

最低限、次を記録します。

- affected package/versionとexact commit/tag
- affected providerとaccounting-domain selector
- riskのあるinvariant: bypass/double-spend、conservative overcharge、incompatible/corrupt state、remote authentication、release-distribution defect
- newer schema/stateがすでに書かれた可能性
- known safe target versionとpersisted-state compatibility
- containment actionとtimestamp

security-sensitive defectはpublic exploit detailより先にGitHub private vulnerability reportingを使います。

## Severity / immediate containment

| Scenario | Initial severity | Immediate action |
| --- | --- | --- |
| quota bypass / double-spend / unauthenticated remote Store access | Critical | affected routeまたはnew cost-bearing dispatchをblock、authoritative state保持、security process開始 |
| corrupted / incompatible persisted state | Critical/High | affected accounting domainへのwrite停止、repair前にsnapshot/backup |
| conservative overcharge / retained-capacity defect | High | materialならaffected workを停止/縮小。proofなしでstate削除による「refund」をしない |
| runtime impact未確認のknown-bad source/package artifact | High/Medium | affected/supersededを明示しinstall推奨停止、fixed release準備 |

## Rollback判断

この順序で決めます。

1. **candidate older runtimeが、すでに書かれた全persisted shapeを読めるか。**
   - Yes: rollback検討可。
   - No / unknown: live domainへdowngradeしない。
2. **incompatible write前のprovider-native snapshotを、1 complete authoritative domainとしてrestoreできるか。**
   - Yes: old/restored copyへの同時writeを防ぐexplicit outage/cutover planの下でのみrestore。
   - No: compatible hotfixへroll forward。
3. older binaryを起動させる目的で `schemaVersion`、SQL migration marker、Redis JSON、Firestore document、domain selectorを編集しない。

Provider別:

- **Redis:** `schemaVersion: 1` でもarbitrary rollbackは不可。older codeが既存scalar/vector/growth/replay fieldを全て理解する場合のみrollback可。それ以外はroll forwardまたはcompatible complete snapshot/domain restore。
- **Firestore:** reservation / budget collectionは1 accounting domain。片側だけcopy/restoreしない。target runtimeがcurrent document shapeを全て理解する必要がある。
- **Cloudflare Durable Objects:** SQLite schema v3へ到達後、max schemaがv3未満のruntimeはrollback targetにできない。`usage_control_schema.version` を下げず、roll forwardまたはcompatible snapshot restore。

## Emergency patch release gate

緊急でもaccounting evidence floorは省略しません。

- sanitized evidenceでdefectを再現またはcharacterize
- 可能ならaffected invariantのregression test追加
- complete Node / Redis / package matrix
- affected pathが触る場合はCloudflare workerd / Firestore Emulator evidence
- package content / clean-consumer import確認
- affected providerのpersisted-state compatibility確認
- affected version、impact、mitigation、safe target、rollback/schema warningをdocument

incident時に無関係なexploratory workは減らせますが、defect classをcoverするrelease-critical invariant testはskipしません。

## GitHub/source release containment

known-bad GitHub/source releaseでは:

1. GitHub security guidance上必要な場合を除き、tag/releaseはaudit evidenceとして保持
2. release title/bodyへ **KNOWN BAD / SUPERSEDED** とadvisory/fixed version linkを明示
3. 既存assetを別bytesへsilent replaceしない
4. separately tested commitからfixed patch releaseを作る
5. support/release noteをsafe target versionへ更新

## #6後のnpm containment

npm publication開始後はdestructive unpublishへ依存せず、npm deprecation/advisoryを優先します。fixed versionをpublishし、必要ならaffected versionへsafe targetを示す短いdeprecation messageを付け、clean installで意図したversionへ解決することを確認します。registry publicationはsource releaseと別authorizationのままです。

## Tabletop drill checklist

v1前、およびmaterialなpersisted-schema変更後に実施します。

### Redis

- test domainの `prefix` / `hashTag` を特定
- scalar + vector/progressive retained stateを作成
- current releaseをknown-badと仮定
- rollback targetが全shapeを読めることを証明、できなければroll-forward選択
- domain-selector変更によるaccidental fresh quotaが無いことを確認

### Firestore

- `collectionPrefix` を特定しreservation/budget collectionを一緒にsnapshot
- Emulatorでactive / settled state作成
- exact document shapeに対するrollback compatibility判断
- incompatible targetがdocumentをabsent扱いせずfail closedすることを確認
- restore/cutoverは1 authoritative domainとしてのみ実施

### Cloudflare

- workerd test domainをcurrent schemaへinitialize/migrate
- max schemaが低いolder runtimeを仮定
- schema marker downgradeではなくroll-forward / compatible snapshot restoreを選ぶことを確認
- normal hotfixではDurable Object/accounting identityを変えない

## Communication template fields

public incident/advisoryでは最低限次を回答します。

- affected versions/providers
- user-visible / accounting / security impact
- authoritative stateが影響を受ける可能性
- immediate mitigation
- safe fixed version
- rollback compatibility warning
- credential/domain identity変更の要否
- additional reconciliationの要否
