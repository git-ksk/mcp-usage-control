# 競合capability map

[English](competitive-capabilities.md) | [日本語](competitive-capabilities.ja.md)

最終レビュー: **2026-08-29**。

これはfeature数やperformance rankingではなく、product boundaryの監査です。隣接するrate-limit / quota / entitlement製品は `mcp-usage-control` より広い問題を扱います。transactional usage enforcementまたは安全なintegration UXを改善し、billing / gateway / control-plane authorityをcoreへ持ち込まないものだけを採用します。

判断区分:

- **Covered** — 既存MCPUsage primitiveですでに満たす。
- **Adopt** — provider-neutralな追加としてlibraryへ入れる価値がある。
- **Helper/docs** — integration上有用だがauthoritative accounting stateにはしない。
- **Out of scope** — gateway / entitlement / billing / product control planeへ残す。

| 隣接capability | Evidence | MCPUsage mapping | 判断 |
| --- | --- | --- | --- |
| remaining + known reset metadata | Upstash `getRemaining()` はremaining/resetを返し、Kongはlimit/remaining/resetと `Retry-After` を公開。Unkeyもfirst-party資料でlimit/remaining/resetを返す設計を示す | authoritative `remainingByBudget`、scoped quota projection、calendar window key | **Adopt** safe window/reset projection (#183)。protocol headerはcore外 |
| 複数limitの同時適用 | Kong Advancedは複数window、Envoy RLSは複数descriptorを扱い、いずれかover-limitならdeny | atomic multi-budget reserve、heterogeneous vector usage | **Covered** |
| weighted request cost | Envoy RLSの `hits_addend`、Kong AIのquery cost | weighted credits、progressive growth、vector dimension | **Covered** |
| dynamic per-user / plan limit | Upstash dynamic limits、Unkey identifier override、Kong consumer-group policy | application-owned entitlement + same-key mutable limit | **Covered**。control planeはapplication-owned |
| threshold notification | OpenMeter entitlement threshold event | scoped threshold/exhaustion helper | **Helper/docs**。delivery / durable notification stateはcore外 |
| grant / rollover / entitlement reset | OpenMeter grant、void、rollover、reset anchor | application-owned entitlement/window policy | **Out of scope** |
| waiting room / delayed retry | Upstash `blockUntilReady`、Kong throttling queue/retry | 意図的に無し | **Out of scope**。gateway/runtime schedulingの責務 |
| dashboard / analytics / deny list | Upstash / Unkeyのdashboard、analytics、control-plane機能 | safe observability projectionのみ | **Out of scope** |
| backend timeout時のfail-open | Upstashはtimeout時にallowできる挙動をdocument。Envoy RLQSもno-assignment / expired-assignment behaviorをconfig可能 | authoritative Store ambiguityではnew admissionをfail closed | **Out of scope / 明示的に不採用** |
| approximate / assigned global quota | Envoy RLQSはquota assignmentを配布。Unkeyはcross-region convergence改善をdocument | participating budgetは1 authoritative transaction domain | **coreではOut of scope**。同等のstrict invariantを証明できる場合のみ再検討 |
| provider deployment trade-off | Kongはlocal/cluster/Redisのaccuracy/performance trade-offを明示 | 現在は定性的provider guide | **Adopt** reproducible provider benchmark/cost profile (#184) |

## 明示的に採用しないもの

このmatrixは次をauthorizeしません。

- ambiguous authoritative accounting failure向けgeneric fail-open mode
- eventually-consistent global usageをstrict accountingと同等に扱うmode
- grant / subscription / paymentのsource of truth
- dashboard、deny-list、gateway、waiting-room、traffic shaping control plane
- unrelated budget / vector dimensionを1つのclient-facing quotaへ合成すること
- opaque custom budget keyからreset timestampを推測すること

## 名前が違うだけで既にある強み

競合側の用語だけを見ると未対応に見えるものがあります。

- "multiple limits" -> atomic multi-budget admission
- "cost" / "weighted hits" -> weighted credits / progressive growth / vector usage
- "per-customer override" -> application-owned entitlement resolution + mutable same-key limit
- "threshold alert" -> `evaluateUsageQuotaThreshold()` / `didUsageQuotaThresholdCross()` + external delivery sink
- "request status/reconciliation" -> scalar operation reconciliation + provider-specific lost-ACK handling

新しいfeature issueを作る前に、このmappingを確認します。

## 再レビュー条件

major / stable release boundaryごと、およびpositioningがmaterialに変わったときに再監査します。新しい競合capabilityを見つけた場合は、coreを暗黙に広げず `Covered` / `Adopt` / `Helper/docs` / `Out of scope` のどれかを明示します。

## 2026-08-29に確認した一次資料

- Upstash Ratelimit methods / feature overview: https://upstash.com/docs/redis/sdks/ratelimit-ts/methods / https://upstash.com/docs/redis/sdks/ratelimit-ts/gettingstarted
- Kong Rate Limiting Advanced / AI Rate Limiting Advanced: https://developer.konghq.com/plugins/rate-limiting-advanced/ / https://developer.konghq.com/plugins/ai-rate-limiting-advanced/
- OpenMeter entitlement notifications / grants: https://openmeter.io/docs/integrations/notifications/entitlements / https://openmeter.io/docs/billing/entitlements/grant
- Unkey changelog / first-party rate-limit material: https://www.unkey.com/changelog / https://www.unkey.com/blog/why-we-built-unkey
- Envoy RLS / RLQS: https://www.envoyproxy.io/docs/envoy/latest/api-v3/service/ratelimit/v3/rls.proto / https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/rate_limit_quota_filter
