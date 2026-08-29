# v1.0 readiness review

[English](v1-readiness.md) | [日本語](v1-readiness.ja.md)

この文書は、将来のv1.0に向けて蓄積したevidenceを記録する **readiness assessment** です。v1 release指示でも、取り消せないAPI-freeze decisionでもありません。

この文書だけでv1.0 tag、GitHub Release、npm publicationを実行しません。

## 現在のstatus

**v0.10.0がcurrent GitHub/source release baselineです。** publish可能な5 package manifestは `0.10.0` に揃っています。

packageは **npm未公開** です。first registry publicationは#6で別途追跡し、source releaseとは独立したexplicit authorizationが必要です。

active decision gateは **v0.11.0 / #152 -> #105 + #106 -> #24 -> #6 accounting-contract / completion / distribution / API freeze**、その後に新featureなしのv1.0 stable promotionです。

## 判定

**core accounting modelはstrong v1 candidateで、v0.10によりoperational-usability gateは完了しました。ただしv1.0 promotion段階にはまだ到達していません。**

すでにproof / adoptできているもの:

- scalar atomic admission/reservation + conservative liability/expiry semantics
- optional progressive scalar growth (#83)、v0.6でadopted
- optional atomic heterogeneous vector (#84)、v0.7でadopted
- optional read-only scalar operation reconciliation (#81)、v0.8でadopted
- repository-wide safety hardening #116〜#127、v0.9でcomplete
- Firestore vector growth-vs-settle blocker #143をrace invariantを弱めず解消
- bounded operational snapshot/runtime identity (#76)、v0.10でcomplete
- canonical settlement outcome normalization + distinguishable bounded diagnostics (#99)、v0.10でcomplete
- scoped threshold/exhaustion helper (#82)、v0.10でcomplete
- Node 20/22/24 package + clean-consumer validation
- Redis / Cloudflare local workerd / Firestore Emulator provider evidence
- ambiguous state-changing outcomeのfail-closed扱い
- MCP multi-round one-time / binding-aware resume semantics
- non-authoritative observability boundary

v1 promotionまでに残るもの:

- cost-bearing operation lifecycle mappingとshared accounting-scope proof (#152)
- v1 Node.js support floorの明示 (#105)
- persisted-store migration / rollback / newer-schema compatibility contract (#106)
- final Cloudflare real-operation boundary (#24)
- separate authorization付きfirst npm publication + registry/provenance dogfood (#6)
- public package / export / API terminologyのfinal freeze
- MCP Tasks / MRTR scopeのfinal decision
- unresolved v1 blockerなしのfinal production/distribution evidence

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
12. business-operation / result replayはapplication-owned
13. observabilityはenforcement stateを変更できない
14. provider durability/time/HA/lost-ACK制約を明示する
15. entitlement / subscription / pricing catalog / provider-health policyはapplication-ownedのままとし、MCPUsage内にsecond authorityを作らない

## Adopt済みv1 capability candidate

### Progressive reservation growth (#83) — v0.6でadopted

`UsageLease.grow()` / optional `ProgressiveUsageStore` はthird-party Storeへgrowthをmandatory化せずincremental capacityを追加します。atomic all-budget growth、stable increment identity、lost-ACK replay fencing、terminal-state rejection、pending/liable semantics継承、total committed capacity以内のsettlementをproof済みです。

### Heterogeneous multi-dimensional usage (#84) — v0.7でadopted

`VectorUsageControl` / optional `VectorUsageStore` はdimensionをsemantically distinctに保ちながら、1 logical replay identityと1 reservation-wide atomic transaction domainを維持します。Memory / Redis / Cloudflare Durable Objects / Firestoreでprovider evidenceがあります。

### Scalar operation reconciliation (#81) — v0.8でadopted

optional `OperationReconciliationStore` はread-only `absent` / `active` / `expired` / `settled` statusを提供します。backend/transport failure、corrupt state、unsupported mode、trusted-input mismatchを`absent`へ変換せずindeterminate / fail closedにします。reconciliationはreserve/release、liability、renew、settle、replay state rewriteを行いません。

### Operational usability (#76/#99/#82) — v0.10でadopted

v0.10ではsecond accounting authorityを作らず、次のexplicit core subpathを追加します。

- `mcp-usage-control/operational`: process-local lifecycle counter、bounded static runtime identity、explicit scoped quota projection
- `mcp-usage-control/settlement-outcomes`: canonical outcome vocabulary、compatibility alias、raw invalid inputを保持しない `invalid_settlement_outcome` diagnostic
- `mcp-usage-control/thresholds`: 明示選択済みquota scopeに対するpure evaluation / crossing helper

重要なnon-claimもcontractの一部です。incomplete/replayable eventからactive reservation数を推測せず、window/reset stateとnotification deliveryはapplication-ownedとし、observer / diagnostic failureでenforcementを変更しません。

release/package gateでは新public subpathをtarball内容とclean-consumer importで検証します。

## v0.9 safety-hardening evidenceのcarry forward

v0.9 auditは新product surfaceではなくcapability intersectionを対象にし、#116〜#127とFirestore blocker #143をcloseしました。scalar/vector accounting、replay、liability、expiry/recovery、fail-closed contractは維持しています。

Firestore outer retryはdefinitive transaction abortであるgRPC `ABORTED` (`10`) / HTTP `409`だけに限定します。`UNKNOWN` / `UNAVAILABLE` / `INVALID_ARGUMENT` などambiguous/provider failureはretry allow-listへ追加しません。

## v0.11 final completion gate

v1 stable promotion前にv0.11で次を優先順にcloseまたは明示scopeします。

1. **#152 cost-bearing operation reservation lifecycle** — provider-backed billable work、shared accounting scope、retry/idempotency、ambiguous outcomeのconservative handling、proven-no-effect releaseをfrozen reserve/liability/settlement contractで表現できることをproofし、不足時のみ新surfaceを追加
2. **#105 supported Node.js floor** と **#106 persisted-store compatibility** — runtime / state compatibility guaranteeをfreeze
3. **#24 Cloudflare real-operation evidence** — credential rotationとhonestなproduction-evidence boundaryを完了
4. **#6 first npm publication** — public contract freeze後、separate explicit authorizationがある場合のみ実施
5. package名、exports/subpath、error/status vocabulary、public lifecycle semantics、MCP Tasks / MRTR decision、final integration/package/deployed/manual evidence

## Distribution boundary

current source-release baselineは `v0.10.0`、5 manifestは `0.10.0` です。

**npm publicationは別操作で、まだ完了していません。** source release成功はregistry publicationを意味しません。#6はfirst publicationを実際に希望し、explicit authorizationし、完了・verifyするまでopenのままです。

## v1 promotion rule

v1.0では **新featureやaccounting modelを追加しません**。v0.11 completion criteria、public surface freeze、final green evidenceを満たし、v1 blocker分類の未解決Issueが0になった場合だけpromotionします。

[Roadmap](roadmap.ja.md)、[Release policy](releasing.ja.md)、各provider docsでcurrent support boundaryを確認してください。
