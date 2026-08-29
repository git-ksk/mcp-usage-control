# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

このdocumentは将来のv1.0に向けて蓄積したevidenceを記録する **readiness assessment** です。release指示でもpackage publishのauthorizationでもありません。

このdocumentだけでv1.0 tag、GitHub Release、npm publicationを実行しません。

## 現在のstatus

**v0.10.0がcurrent GitHub/source release baselineです。** publish可能な5 package manifestは `0.10.0` に揃い、Node.js 22以上をrequireします。

packageは **npm未公開** です。first registry publicationは#6で別途追跡し、source releaseとは独立したexplicit authorizationが必要です。

v0.11 completion lineでは、最初のaccounting / reliability / runtime trancheを解消しました。

- #166 Redis renewed-lease reliabilityはcross-file `FLUSHDB` test interferenceが原因と判明し、Redis runtime semanticsを変えずに修正
- #105でsupported Node.js floorを **22+** にfreeze。Node 22/24がsupported evidence、Node 20はcurrent required check context維持中のみcompatibility-only
- #157でFirestore Emulator progressive-growth contentionを分類し、`INVALID_ARGUMENT`をStore runtime retryへ追加せず反復diagnostic stressを導入
- #152でprovider-backed cost-bearing workを既存のvector reserve / liability / grow / renew / settle contractへfreezeし、billing-specific public primitiveは追加しない

残るactive v0.11 sequenceは **#106 persisted-state compatibility -> #160 release-safety enforcement + #161 public API/name freeze -> #24 final Cloudflare evidence -> final v0.11 release evidence** です。#6は別publication gateで、明示authorizationがある場合だけ実行します。

## 判定

**accounting modelはstrong v1 candidateのままで、主要semantic / runtime reliability decisionはfreezeできました。ただしremaining compatibility、API、production evidence、merge governance gateを閉じるまでv1.0 promotionはしません。**

## Stable accounting invariant

v0.11 / v1.0を通して次を崩しません。

1. admission compare + reservationはauthoritative Storeの1 operation
2. admissionに必要な全budget / dimensionはatomic commit、またはnone commit
3. replay identityは1 logical operationの `(tenantId, principal.id, tool, operationId)`
4. metered execution前にexplicit liability
5. renewはlease durationのみ変更しreserved capacityを変えない
6. pending expiryはrelease可、liable unknown usageはconservative
7. settlementはsuccessfully reserved capacity以内
8. ambiguous state-changing outcomeをblind retryしない
9. scalar/vectorで異種dimensionを1 synthetic totalへ潰さない
10. MCP multi-round resumeはintegrity-verified / binding-aware / one-time
11. resumeで2個目のusage reservationを作らない
12. business-operation idempotency / result replayはapplication-owned
13. observabilityはenforcement stateを変更できない
14. provider durability / time / HA / lost-ACK制約を明示する
15. entitlement、subscription、pricing catalog、currency conversion、provider-health policy、financial reconciliationはapplication-owned
16. hard provider-spend enforcementはmaximum billable exposureをdispatch前にreserveするか、追加billable work前にatomic growできる場合だけclaimする

## Adopt済みv1 capability candidate

### Progressive reservation growth (#83) — v0.6でadopted

`UsageLease.grow()` / optional `ProgressiveUsageStore` はbounded incremental capacityを提供します。atomic all-budget growth、stable increment identity、lost-ACK replay fencing、pending/liable semantics、terminal-state rejection、total committed capacity以内のsettlementをproof済みです。

### Heterogeneous multi-dimensional usage (#84) — v0.7でadopted

`VectorUsageControl` / optional `VectorUsageStore` は異種dimensionをsemantically distinctに保ちながら、1 logical operation identityと1 reservation-wide atomic transaction domainを維持します。Memory / Redis / Cloudflare Durable Objects / Firestoreでvector modelのprovider evidenceがあります。

### Scalar operation reconciliation (#81) — v0.8でadopted

optional `OperationReconciliationStore` はread-only `absent` / `active` / `expired` / `settled` statusを提供します。backend failure、corrupt state、unsupported mode、trusted-input mismatchを`absent`へ変換せずindeterminate / fail closedにします。

### Operational usability (#76/#99/#82) — v0.10でadopted

v0.10のpublic subpathはnon-authoritativeのままです。

- `mcp-usage-control/operational` — bounded process-local lifecycle counter、runtime identity、explicit scoped quota projection
- `mcp-usage-control/settlement-outcomes` — canonical settlement vocabulary、compatibility alias、bounded invalid-outcome diagnostic
- `mcp-usage-control/thresholds` — application-selected quota scopeに対するpure threshold evaluation / crossing helper

observer / diagnostic failureはadmission、liability、renewal、growth、settlementを変更できません。

### Cost-bearing provider work (#152) — v0.11でfreeze

既存public surfaceで十分で、v0.11では **billing-specific accounting primitiveを追加しません**。

採用するcompositionは次です。

```text
application-owned entitlement / accounting scope / pricing
  -> bounded maximum exposureをatomic vector reserve
  -> billable dispatch直前にmark liable
  -> additional billable exposure前にgrow
  -> authoritative work / evidence保持中はrenew
  -> authoritative actual usageでsettle
```

focused proofで次を確認します。

- 複数caller principalがopaque budget keyを通じて1つのapplication-selected shared accounting scopeを消費できる
- count quotaとprovider-cost budgetを別vector dimensionとして維持する
- provider costはapplication-defined safe integer / fixed-scale unitを使う
- settlementはsuccessfully reserved exposureを超えず、unused capacityをreleaseする
- pre-dispatchでno effectを証明できれば0 settleできる
- billable retryは追加exposureのgrowth成功後だけdispatchする
- growth denyでretry dispatchを止める
- post-dispatch / liable ambiguityはreserved exposureをconservativeに保持する
- stable logical operation identityでduplicate reservationを防ぐ

providerがcontrollable pre-growth boundaryなしでunbounded costを増やせる場合、このlibraryによるhard spend capをclaimしてはいけません。delayed provider usageはleaseをauthoritatively保持 / renewできる間、またはinitial reservationがdefensible maximumをcoverする場合だけbounded supportします。durable post-hoc financial reconciliationはcore外です。

詳しくは [Cost-bearing operation](cost-bearing-operations.ja.md)。

## v0.11 reliability / runtime evidence

### Redis renewal reliability (#166) — complete

renewed-lease failureは、複数Vitest fileが1つのRedis DBを共有しながら独立に `FLUSHDB` していたことが原因でした。Redis runtime renewalはRedis server `TIME`を維持し、test harnessをserial化してtiming proofを広げました。修正後はNode 20/22/24 evidenceがpassしています。

### Firestore progressive growth contention (#157) — complete

Firestore Emulatorはidentical-increment / distinct-increment contentionの両方で `3 INVALID_ARGUMENT: Transaction is invalid or closed.` を返す場合があります。

runtime retry allow-listはdefinitive transaction abortだけに維持し、`INVALID_ARGUMENT`をblanket retryしません。

diagnostic stressでは既存idempotency fenceによるauthoritative resolutionをproofします。

- identical increment ambiguity + observed winner -> exact replayが `accepted + replayed` とcommitted reserved totalへ収束
- distinct stale-cursor loser ambiguity -> exact replayがauthoritative `UsageStateError`へ収束
- distinct replayがunexpected commitした場合はpossible double-commit invariant violationとしてtest failure

実際にambiguity-resolution pathを踏みながら24-iteration Emulator runを反復passし、このstressをFirestore integration gateへ追加しました。

### Node.js support floor (#105) — complete

5 public package manifestはすべて `engines.node >=22` です。Node.js 22 / 24をsupported v1 runtime evidenceとします。Node 20はEOLでv1 support対象外ですが、#160でprotected required-check policyを安全にmigrationできるまでCI contextのみcompatibility-onlyとして残します。

## v1 promotionまでの残件

1. **#106 persisted-store compatibility** — Redis / Firestore / Cloudflareのschema/version ownership、upgrade behavior、rollback safety、newer-schema fail-closed behavior、operator reset/migration boundaryをfreeze
2. **#161 public API/name freeze** — settlement outcome typing boundary、package名、exports/subpath、error/status vocabulary、lifecycle terminology、scalar/vector parity、MCP Tasks/MRTR scopeをfinal review
3. **#160 release-safety enforcement** — path-aware provider safety checkは存在するが、applicableなrelease-critical evidenceをbypassできないrequired-check / ruleset policyをfinalize。current connectorではbranch protection writeができないためadministrative stepは明示残件
4. **#24 Cloudflare real-operation evidence** — real credential rotationを実施し、honestなv1 production claimをfinalize。platform-limit eventを作るためだけにshared quotaを意図的に消費しない
5. **final v0.11 release evidence** — supported Node/package check、Redis、Cloudflare workerd、Firestore Emulator、package tarball / clean consumer、英日docs、final public contractをすべてgreenにし、unresolved v1 blockerを0にする

## npm distribution boundary

source-release baselineはv0.11をcutするまで `v0.10.0` のままです。npm publicationは別操作で、まだ実行していません。

#6はfirst publicationを実際に希望し、**separate explicit authorization** を行い、package ownership / availability、provenance、registry metadata、package content、clean-consumer installをverifyするまでopenのままです。

source releaseがregistry publicationを暗黙authorizeすることはありません。

## v1 promotion rule

v1.0では **新featureやaccounting modelを追加しません**。v0.11でremaining compatibility / API / production / governance gateを閉じ、public surfaceをfreezeし、release-critical evidenceをaccidental bypassから保護し、final evidenceがgreenで、v1 blocker分類のIssueが0になった場合だけpromotionします。

[Roadmap](roadmap.ja.md)、[Release policy](releasing.ja.md)、[Cost-bearing operation](cost-bearing-operations.ja.md)、各provider docsでcurrent support boundaryを確認してください。
