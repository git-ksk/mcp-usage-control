# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

このdocumentは将来のv1.0に向けて蓄積したevidenceを記録する **readiness assessment** です。release指示でもpackage publishのauthorizationでもありません。

このdocumentだけでv1.0 tag、GitHub Release、npm publicationを実行しません。

## 現在のstatus

**v0.10.0がcurrent GitHub/source release baselineです。** publish可能な5 package manifestは `0.10.0` に揃い、Node.js 22以上をrequireします。

packageは **npm未公開** です。first registry publicationは#6で別途追跡し、source releaseとは独立したexplicit authorizationが必要です。

v0.11 freeze lineでは、accounting / reliability / runtime / storage / API / governance trancheを解消しました。

- #166 Redis renewed-lease reliabilityはcross-file `FLUSHDB` interferenceが原因と判明し、Redis runtime semanticsを変えずに修正
- #105でsupported Node.js floorを **22+** にfreeze。Node 22/24がsupported evidence、Node 20はcompatibility-only
- #157でFirestore Emulator progressive-growth contentionを分類し、`INVALID_ARGUMENT`をStore runtime retryへ追加せず反復diagnostic stressを導入
- #152でprovider-backed cost-bearing workを既存のvector reserve / liability / grow / renew / settle contractへfreeze
- #106でRedis / Firestore / Cloudflare persisted-stateのupgrade、rollback、future-schema fail-closed、fresh-domain reset境界をfreeze
- #161でv1 package / lifecycle / status / error vocabularyをfreezeし、MCP settlement alias normalizationを明示
- #160でprotectedな `test (22)` をapplicableなNode / Redis / package / Cloudflare / Firestore evidenceのaggregate release-safety gateへ変更

残るv0.11 blockerは **#24 final real-Cloudflare operational evidence** と、その後のfinal v0.11 release evidenceだけです。#6は別publication gateで、明示authorizationがある場合だけ実行します。

## 判定

**public accounting / runtime / storage / API / governance surfaceはv1候補としてfreezeできました。残るblockerはCloudflare adapterのproduction-evidence honestyであり、core semanticやAPIの未決定事項ではありません。**

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

```text
application-owned entitlement / accounting scope / pricing
  -> bounded maximum exposureをatomic vector reserve
  -> billable dispatch直前にmark liable
  -> additional billable exposure前にgrow
  -> authoritative work / evidence保持中はrenew
  -> authoritative actual usageでsettle
```

focused proofではshared accounting scope、count / provider-costの別dimension、safe integer / fixed-scale cost unit、bounded settlement、proven-no-effect release、retry pre-growth、growth-denial stop、conservative liable ambiguity、duplicate-operation protectionを確認しています。

詳しくは [Cost-bearing operation](cost-bearing-operations.ja.md)。

## v0.11 reliability / compatibility / API evidence

### Redis renewal reliability (#166) — complete

renewed-lease failureは、複数Vitest fileが1つのRedis DBを共有しながら独立に `FLUSHDB` していたことが原因でした。Redis runtime renewalはRedis server `TIME`を維持し、test harnessをserial化してtiming proofを広げました。

### Firestore progressive growth contention (#157) — complete

Firestore Emulatorはidentical-increment / distinct-increment contentionで `3 INVALID_ARGUMENT: Transaction is invalid or closed.` を返す場合があります。runtime retryはdefinitive transaction abortだけに限定したまま、existing idempotency fenceによるauthoritative resolutionをdiagnostic stressでproofし、integration gateへ入れました。

### Node.js support floor (#105) — complete

5 public package manifestはすべて `engines.node >=22` です。Node.js 22 / 24をsupported v1 runtime evidenceとします。Node 20はEOLでcompatibility-onlyです。

### Persisted-state compatibility (#106) — complete

Redisの新規stateは `schemaVersion: 1`、exact legacy unversioned stateはin-place互換読取、unsupported future versionはmutation前にfail closedです。Firestoreはversioned reservation / budget documentとunknown-version rejection、Cloudflare Durable Objectsはexplicit SQLite migrationとfuture-schema rejectionを維持します。provider別upgrade / rollback / reset境界もdocument済みです。

### Public API/name freeze (#161) — complete

Store-facing / direct lease settlement outcomeは意図的にextensible stringを維持し、portable canonical vocabularyは `mcp-usage-control/settlement-outcomes` に置きます。built-in MCP adapterはcompatibility aliasをauthoritative settlement前にnormalizeします。package名、current subpath、lifecycle/status/error vocabulary、scalar/vector parity、MCP multi-round scopeもfreeze済みです。

### Aggregate release-safety enforcement (#160) — complete

`test (22)` はprotected aggregate release-safety gateです。Node / Redis / package / tarball / clean-consumer matrix全体と、applicableなCloudflare workerd / Firestore Emulator evidenceを必須にします。`test (20)` はcompatibility-only protected contextです。provider skipはpath classifierが非該当と判定した場合だけ許可し、docs-only変更はlightweight pathでrequired contextをdeadlockさせずresolveします。

## v1 promotionまでの残件

1. **#24 Cloudflare real-operation evidence** — real credential rotationを実施し、honestなv1 production claimをfinalize。platform-limit eventを作るためだけにshared quotaを意図的に消費しない
2. **final v0.11 release evidence** — supported Node/package check、Redis、aggregate `test (22)`、Cloudflare workerd、Firestore Emulator、package tarball / clean consumer、英日docs、final public contractをすべてgreenにし、unresolved v1 blockerを0にする

## npm distribution boundary

source-release baselineはv0.11をcutするまで `v0.10.0` のままです。npm publicationは別操作で、まだ実行していません。

#6はfirst publicationを実際に希望し、**separate explicit authorization** を行い、package ownership / availability、provenance、registry metadata、package content、clean-consumer installをverifyするまでopenのままです。

source releaseがregistry publicationを暗黙authorizeすることはありません。

## v1 promotion rule

v1.0では **新featureやaccounting modelを追加しません**。#24 / final v0.11 evidenceで残るproduction-evidence boundaryを閉じ、final source/package/provider evidenceがgreenで、v1 blocker分類のIssueが0になった場合だけpromotionします。

[Roadmap](roadmap.ja.md)、[Release policy](releasing.ja.md)、[Cost-bearing operation](cost-bearing-operations.ja.md)、[Persisted-state compatibility](persisted-state-compatibility.ja.md)、[v1 public API freeze](v1-public-api-freeze.ja.md)、各provider docsでcurrent support boundaryを確認してください。
