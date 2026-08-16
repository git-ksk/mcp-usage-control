# Roadmap

このRoadmapは、projectのcore categoryである **MCP execution boundaryのfailure-safe transactional usage enforcement** を守るためのものです。

```text
quote -> atomic reserve -> mark liable -> execute -> renew -> settle
```

このprojectはgeneric agent-budget、gateway、billing、governance、workflow productへ広げるのではなく、この境界のcorrectnessを深くします。戦略上の境界は [Project positioning](positioning.ja.md) を参照してください。

## 現在のrelease方針

次のsource releaseは **v1.0.0ではなくv0.5.0** です。

v0.5.0はv0.4.0以降のcorrectness / compatibility workをまとめるpre-v1 stabilization releaseです。

- Firestore ambiguous commit / lost-ACK semanticsとfault-injection evidence (#77)
- boundedなFirestore cross-instance clock-skew supportとdeterministic evidence (#78)
- Node.js 24をNode 20 / 22と同じfull CI / package / clean-consumer pathで検証 (#79)
- same-key mutable quota-limit semanticsとMemory / Redis / Cloudflare / Firestore共通portable Store conformance (#85)
- Cloudflare Bearer token rotation supportとlocal workerd rotation coverage
- #83 / #84に関するcurrent accounting-model boundaryの文書化

v1 readiness workで得たevidenceはそのまま有効ですが、**v1を直近の次release、またはすでにAPI freeze済みとは扱いません**。v0.5.0の運用後、integration需要と実装経験を見てopen capabilityのどこまでをv1へ入れるか再判断します。

## current v0.5 behaviorとv1候補

v0.5.0は現在proof済みのaccounting modelを維持します。

- metered work前にboundedなfixed reservationを確保
- `actualUnits <= reservedUnits`
- 1 reservationに参加する全budgetへ1つのscalar quoted / actual unit countを適用
- participating budgetは全部atomic admit、または全部deny
- second logical operationをaccounting-equivalentなtop-up workaroundとは扱わない
- all-or-nothing admissionが必要な場面でdimension別independent reserveを同等代替とは扱わない

これらは **v0.5 behavior + current v1 candidate** であり、取り消せないv1 freezeではありません。

特に:

- #83 progressive reservation growthはopenのまま。failure-safe atomic top-up protocolをv1前にproofできればv1へ入れてよい
- #84 heterogeneous multi-dimensional usageもopenのまま。provider-neutral atomic vector modelをv1前にproofできればv1へ入れてよい
- 既存transaction guaranteeを不安定にする、またはevidence不足のままstable surfaceを広げる場合はpost-v1へ残せる

以前「post-v1」と分類したからという理由だけでv1から外しません。v1 boundaryは実需要・failure evidence・互換性から決めます。

## Current priorities

1. **v0.5.0 release** — 5 packageを同時versioningし、full matrix green後にGitHub/source release。npm publicationは別工程のままdeferred。
2. **v0.5 stabilization / dogfood** — Firestore failure envelope、mutable-limit contract、Node 24 path、portable Store conformance、Cloudflare credential rotationを通常利用で観測。
3. **v1 scope再評価** — #83 / #84、および他のlow-risk / high-valueなopen capabilityをactual API freeze前にv1へ含めるか判断。
4. **Cloudflare operational evidence (#24)** — genuine platform-limit / overload / Free-plan exhaustionを自然かつ安全に観測できた場合にcapture。Issueを閉じるためだけにshared quotaを消費しない。
5. **First npm publication (#6)** — separate explicit authorizationまでmanual / deferred。
6. **Failure semantics maintenance** — crash recovery、ACK ambiguity、liability、cancellation、multi-round claim / recovery、Tasks lifetime、reconciliation、mutable-policy boundary、Store-specific durability assumptionをupstream変化に合わせて明示し続ける。

## v1に向けたIssue分類

| Issue | 現在の分類 | v1での扱い |
| --- | --- | --- |
| #76 operational usage snapshot | Future optional operational capability | non-authoritative / low-riskならv1候補として再評価可 |
| #77 Firestore ambiguous-commit reconciliation | **解決済みcorrectness / evidence gate** | v0.5および将来v1へevidenceを継承 |
| #78 Firestore cross-instance clock skew | **解決済みsafety / evidence gate** | v0.5および将来v1へevidenceを継承 |
| #79 Node 24 CI evidence | **解決済みsupport-policy gate** | Node 20 / 22 / 24をtested lineとして維持 |
| #81 operation reconciliation / status capability | Future capability | authoritative semanticsを明確にできる場合だけv1再評価 |
| #82 quota threshold / exhaustion signals | Future optional operational capability | non-authoritative toolingとしてのみv1再評価 |
| #83 progressive reservation growth | **open v1-scope candidate** | v0.5はtop-upなし。v1採用はfailure model proof後に判断 |
| #84 heterogeneous multi-dimensional usage | **open v1-scope candidate** | v0.5はscalar model。v1採用はatomic vector design proof後に判断 |
| #85 mutable quota-limit semantics | **解決済みpolicy / Store-contract gate** | portable conformanceをv0.5 evidence baseへ含める |

これは以前の「#83 / #84を確定post-v1」としたplanning assumptionを更新します。以前のanalysis自体はdesign inputとして残し、変えるのはrelease boundaryの最終性だけです。

## MCP-native correctness

protocol固有機能はexecution boundaryのaccounting safetyを変える場合だけcoreへ入れます。

### Multi-round request / response

current directionはshared / durable flow claim + atomic compare-and-consumeです。

- logical operationごとにreservation 1回
- client round-trip request stateのintegrity verification
- trusted principal / tenant / tool / args binding
- one-time resume claim
- mismatch時に正当なstateを保持
- ambiguous consume ACKをfail closed
- sticky MCP session不要
- execution開始後のconservative liability behavior

新しいstateless / client-carried claimは、同等のone-time / ambiguity safetyと具体的なoperational advantageをproofするまでdeferredです。

### MCP Tasks

[MCP Tasks の利用量 accounting](mcp-tasks-accounting.ja.md) でsafe accounting lifecycleは定義・proof済みです。ただしupstream TypeScript integration surfaceがexperimentalな間、first-class Tasks protocol adapterはdeferred / experimentalです。これは既存core primitiveのcorrectness gapではなくv1 scope decisionとして扱います。

## Third-party Store contract

portable invariant kitは実装済みです。詳しくは [Store実装contract](store-contract.ja.md)。

```ts
import { assertUsageStoreConformance } from 'mcp-usage-control/conformance';
import { assertMcpUsageFlowStoreConformance } from 'mcp-usage-control-mcp/conformance';
```

compatible Storeはatomic admission、replay / idempotency、pending / liable expiry、renew / resume、conflicting settlement rejection、mutable-limit semantics、invalid / ambiguous stateのfail closedを維持する必要があります。portable runner合格だけでbackend durability / failover / authoritative time / lost-ACK safetyまで証明したことにはなりません。

## External billing / metering

境界を次のまま維持します。

```text
transactional enforcement core
        -> best-effort observer / stable package API
        -> optional billing/telemetry adapter
```

financial-grade ledger、payment / subscription system、pricing catalog、gateway / router、OAuth provider、arbitrary business-side-effect replay engineはcore transaction modelの外です。

## Future candidates

v1前は、具体的価値とfailure evidenceが追加stable surfaceを正当化できる場合だけv1 scopeへ取り込みます。v1後もnormal compatibility constraintの下で同じ原則を使います。

候補:

- #76 operational snapshot。second accounting source of truthは作らない
- #81 authoritative operation reconciliation / status。Storeがproofできる場合のみ
- #82 threshold / exhaustion helper。non-authoritative operational toolingのみ
- #83 progressive reservation growth。atomic top-up identity / replay / lost-ACK / expiry proof必須
- #84 heterogeneous multi-dimensional usage。provider-neutral atomic vector semantics必須
- standalone versioned telemetry / event wire schema
- optional billing / metering adapter
- additional production policy example
- upstream stabilizes後のfirst-class MCP Tasks adapter
- equivalent one-time / ambiguity proofを持つalternative MRTR claim
- 同じconformance / failure contractを満たすadditional provider Store

## Non-goals

core runtimeはgeneric agent runtime / budget authority、ordinary HTTP rate limiter、payment / subscription system、financial ledger、OAuth provider、billing dashboard / pricing catalog、gateway / router、vendor billing protocol implementation、generic workflow engine、ambiguous state-changing operationをblind retryするsystemにはしません。
