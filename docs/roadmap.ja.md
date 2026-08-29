# Roadmap

[English](roadmap.md) | [日本語](roadmap.ja.md)

このRoadmapは、projectのcore categoryである **MCP execution boundaryのfailure-safe transactional usage enforcement** を守るためのものです。

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

generic gateway、billing ledger、governance system、workflow engineへ広げるのではなく、この境界のcorrectnessとproduction usabilityを深めます。戦略上の境界は [Project positioning](positioning.ja.md) を参照してください。

## 現在のbaseline

**v0.10.0がcurrent GitHub/source release baselineです。** 既存accounting modelを維持したまま、bounded operational usabilityとdogfood diagnosticsを追加します。

publish可能な5 package manifestはすべて `0.10.0` に揃っています。**npmにはまだ公開していません。** first registry publicationは#6で追跡する別途explicit authorization必須の操作です。

active product targetは **v0.11.0 / #152 -> #105 + #106 -> #24 -> #6**、最後に新featureを追加しない **v1.0.0 stable promotion** です。

```text
v0.6 progressive growth [RELEASED]
 -> v0.7 atomic heterogeneous vector [RELEASED]
 -> v0.8 scalar operation reconciliation [RELEASED]
 -> v0.9 repository-wide safety hardening [RELEASED]
 -> v0.10 operational usability [RELEASED]
 -> v0.11 accounting/completion/distribution/API freeze [ACTIVE]
 -> v1.0 stable promotion
```

## 今後も崩さないsafety boundary

残りの全releaseで次を維持します。

- admission compare + reservationはauthoritative Storeの1 transition
- participating budgetは全てatomic reserve、またはnone reserve
- pending / cost-liable expiry semanticsを分離し、unknown usageはconservative
- replay / idempotency identityは1 logical operationへscope
- ambiguous state-changing outcomeをblind retryしない
- scalar / vector accountingで異種dimensionをsynthetic totalへ変換しない
- MCP multi-round resumeはintegrity-verified / binding-aware / one-time
- observabilityはnon-authoritativeでenforcement outcomeを変更できない
- provider durability / time / HA / lost-ACK制約はevidence以上の強いclaimへ勝手に拡張しない

## 完了済みpre-v1 capability decision

| Release | Decision | Status |
| --- | --- | --- |
| **v0.6.0** | `UsageLease.grow()` / `ProgressiveUsageStore` によるoptional progressive reservation growth | Release済み / Adopted |
| **v0.7.0** | `VectorUsageControl` / `VectorUsageStore` によるoptional atomic heterogeneous vector usage | Release済み / Adopted |
| **v0.8.0** | `OperationReconciliationStore` によるoptional read-only scalar operation reconciliation | Release済み / Adopted |
| **v0.9.0** | repository-wide safety hardening #116〜#127 + Firestore race blocker #143 | Release済み / Complete |
| **v0.10.0** | operational snapshot/runtime identity、canonical settlement diagnostics、scoped threshold/exhaustion helper | **Release済み / Adopted** |

### v0.9 safety evidenceのcarry forward

v0.9ではpublic accounting modelを変更せず、capability同士の交差部をhardeningしました。repository-audit safety set #116〜#127とFirestore blocker #143を、`vector-growth-vs-settle-race` のinvariantを弱めずcloseしています。

Firestore outer retryは definitive transaction abortである `ABORTED` / gRPC 10 と HTTP 409だけをbounded jittered backoffでretryします。`UNKNOWN` / `UNAVAILABLE` / `INVALID_ARGUMENT` などambiguous/provider failureはretry allow-listへ追加していません。

## v0.10.0 — operational usability [complete]

Issue **#76 -> #99 -> #82** は完了です。

v0.10ではcoreに3つの明示public subpathを追加します。

- `mcp-usage-control/operational` — process-local bounded lifecycle counter、static runtime identity、明示scopeしたquota projection
- `mcp-usage-control/settlement-outcomes` — canonical settlement vocabulary、bounded alias normalization、区別可能な `invalid_settlement_outcome` diagnostic
- `mcp-usage-control/thresholds` — 明示scope済みquota snapshotに対するpure threshold evaluation / crossing helper

second accounting truthを作らないため、次を明示します。

- operational counterはbest-effort / process-localで、quota enforcementには使わない
- replayable / aggregate lifecycle eventからactive reservation数を推測しない
- authoritative `remaining` はapplicationが正しいbudget/windowを選択した後だけprojectする
- threshold window/reset stateとnotification deliveryはapplication-owned
- invalid outcome diagnosticはsettlement validationを弱めず、rejectしたraw valueを露出しない
- observer / diagnostic sink failureはadmission、liability、renewal、settlementを変更できない

release packagingでは3つの新subpathをnpm tarball内容とclean-consumer importで検証します。英日guideは [Operational usability](operational-usability.ja.md) を参照してください。

## Active target: v0.11.0 — accounting contract / completion / distribution / compatibility freeze

v0.11はfeature expansionではなくfinal pre-v1 completion lineです。

実行優先順:

1. **#152 cost-bearing operation reservation lifecycle** — provider-backed cost-bearing work、shared accounting scope、idempotent retry、ambiguous outcomeのconservative handling、proven-no-effect releaseを既存reserve/liability/settlement modelで表現できるかproofし、不足時のみAPI追加
2. **#105 Node support floor** と **#106 persisted-state compatibility** — runtime / storage compatibility boundaryをfreeze
3. **#24 Cloudflare real-operation boundary** — real credential rotationとhonestなplatform-limit evidence statementを完了
4. **#6 first npm publication** — public contract freeze後、separate explicit authorizationがある場合のみ実施
5. **public API/name freeze + final release evidence**

次をresolveまたは明示scopeします。

- entitlement / pricing / subscription state / provider policyはapplication-ownedのまま維持
- cost-bearing workのshared accounting scope、operation identity、liability、settlement、no-effect/refund mappingを明文化
- Node support、persisted-state upgrade/migration/rollback、newer-schema fail-close guaranteeをfreeze
- 5 package名、exports/subpath、error/status vocabulary、lifecycle semanticsをfinal public-contract review
- MCP Tasks / MRTRはstable upstreamと同等safety proofがあるsurfaceだけadoptし、それ以外は明示defer
- production/package/source-release evidenceをgreenにする
- npm publicationは別途authorizationがある場合だけ実施し、registry/provenance/clean-installまで確認

v0.11 close時点でv1 blocker分類の未解決Issueを残しません。

## 「v1 complete」の定義

v1.0は、未決定事項を最後に解くreleaseではなく、**すでに完成したsurfaceをstableへ昇格するrelease**です。

v1.0前に:

- material capabilityは全てadopt / defer / excludeを明示
- adopted capabilityはfailure semantics、concurrency/provider evidence、packaging coverage、英日docsを完備
- public package名、export、lifecycle semantics、Store support claim、Node support、MCP integration boundaryをfreeze
- cost-bearing operation semanticsをfrozen accounting lifecycleへ明示mapping
- first npm publicationを別途authorizationの下で実地検証
- persisted-state compatibility / rollback boundaryを文書化
- final production evidenceをgreenにする

**v1.0自体では新featureやaccounting modelを追加しません。**

## v1へ向けたIssue分類

| Issue | Target | Direction |
| --- | --- | --- |
| #83 progressive reservation growth | v0.6 | Adopted / released |
| #84 heterogeneous multi-dimensional usage | v0.7 | Adopted / released |
| #81 operation reconciliation/status | v0.8 | Adopted / released |
| #116〜#127 repository safety hardening | v0.9 | Completed / released |
| #143 Firestore vector growth-vs-settle race | v0.9 | Completed release blocker |
| #76 operational usage snapshot | v0.10 | Completed / released |
| #99 settlement outcome normalization / dogfood diagnostics | v0.10 | Completed / released |
| #82 threshold/exhaustion signals | v0.10 | Completed / released |
| #152 cost-bearing operation reservation lifecycle | v0.11 | **Active / accounting-contract freeze** |
| #105 Node.js support floor | v0.11 | Runtime support freeze |
| #106 persisted-store compatibility | v0.11 | Storage compatibility freeze |
| #24 Cloudflare real operational evidence | v0.11 | Final production evidence |
| #6 first npm publication | v0.11 | **Open; separate explicit authorization必須** |

## Release policy

- release mechanicsを楽にするためruntime/accounting semanticsを黙って変更しない
- GitHub/source releaseとnpm publicationはindependent authorization
- GitHub/source release成功はregistry publicationを意味しない
- provider claimは実測/test evidenceを超えて強くしない

[Release policy](releasing.ja.md)、[v1.0 readiness review](v1-readiness.ja.md)、各provider docsをproduction deployment前に確認してください。
