# Competitive capability map

[English](competitive-capabilities.md) | [日本語](competitive-capabilities.ja.md)

Last reviewed: **2026-09-04**.

This is a product-boundary audit, not a feature checklist or performance ranking. Adjacent rate-limit, quota, and entitlement systems solve broader problems than `mcp-usage-control`. A capability is adopted only when it improves transactional usage enforcement or safe integration UX without moving billing, gateway, or control-plane authority into core.

Decisions:

- **Covered** — the need already maps to an existing MCPUsage primitive.
- **Adopt** — a provider-neutral addition belongs in the library.
- **Helper/docs** — useful integration behavior, but not authoritative accounting state.
- **Out of scope** — deliberately belongs to a gateway, entitlement, billing, or product control plane.

| Adjacent capability | Evidence | MCPUsage mapping | Decision |
| --- | --- | --- | --- |
| Remaining + known reset metadata | Upstash `getRemaining()` returns remaining/reset; Kong exposes limit/remaining/reset and `Retry-After`; Unkey has historically exposed limit/remaining/reset with rate-limit decisions | authoritative `remainingByBudget`, scoped quota projection, calendar window keys | **Adopt** safe window/reset projection (#183); protocol headers remain outside core |
| Multiple simultaneous limits | Kong Advanced supports multiple windows; Envoy RLS accepts multiple descriptors and denies if any is over limit | atomic multi-budget reserve; heterogeneous vector usage | **Covered** |
| Weighted request cost | Envoy RLS supports `hits_addend`; Kong AI surfaces query cost | weighted credits; progressive growth; vector dimensions | **Covered** |
| Dynamic per-user/plan limits | Upstash supports dynamic limits; Unkey supports identifier overrides; Kong supports consumer-group policy | application-owned entitlement + same-key mutable limit semantics | **Covered**; control plane remains application-owned |
| Threshold notifications | OpenMeter entitlement thresholds trigger bounded balance events | scoped threshold/exhaustion helpers | **Helper/docs**; delivery/durable notification state stays outside core |
| Grants, rollover, entitlement resets | OpenMeter models grants, voiding, rollover, reset anchors | application-owned entitlement/window policy | **Out of scope** |
| Waiting room / delayed retry | Upstash `blockUntilReady`; Kong throttling queues/retries excess traffic | none by design | **Out of scope**; gateway/runtime scheduling concern |
| Dashboard, analytics, deny lists | Upstash/Unkey expose dashboard/analytics/control-plane features | safe observability projections only | **Out of scope** |
| Fail-open on backend timeout | Upstash documents timeout behavior that can allow requests; Envoy RLQS supports configurable no-assignment/expired-assignment behavior | ambiguous authoritative Store failures fail closed for new admission | **Out of scope / explicitly rejected** |
| Approximate or assigned global quotas | Envoy RLQS distributes quota assignments; Unkey documents cross-region convergence improvements | one authoritative transaction domain for participating budgets | **Out of scope in core** unless equivalent strict invariants can be proven |
| Provider deployment trade-offs | Kong documents local/cluster/Redis accuracy/performance trade-offs | qualitative provider guides today | **Adopt** reproducible provider benchmark/cost profiles (#184) |

## Explicit non-adoption rules

The matrix does not authorize these changes:

- no generic fail-open mode for ambiguous authoritative accounting failures;
- no eventually-consistent global usage mode marketed as equivalent to strict accounting;
- no grant/subscription/payment source of truth;
- no dashboard, deny-list, gateway, waiting-room, or traffic-shaping control plane;
- no client-visible synthetic aggregate across unrelated budgets/vector dimensions;
- no reset timestamp inferred from an opaque custom budget key.

## Existing strengths that use different vocabulary

Competitor terminology can make existing coverage look absent when it is not:

- "multiple limits" maps to atomic multi-budget admission;
- "cost" / "weighted hits" maps to weighted credits, progressive growth, and vector usage;
- "per-customer override" maps to application-owned entitlement resolution plus mutable same-key limits;
- "threshold alert" maps to `evaluateUsageQuotaThreshold()` / `didUsageQuotaThresholdCross()` plus an external delivery sink;
- "request status/reconciliation" maps to scalar operation reconciliation and provider-specific lost-ACK handling.

These mappings should be checked before opening a new feature issue.

## Re-review trigger

Re-audit this page at every major/stable release boundary and whenever positioning materially changes. For each newly observed capability, record one explicit `Covered` / `Adopt` / `Helper/docs` / `Out of scope` decision rather than silently expanding core.

## Primary sources reviewed

- Upstash Ratelimit methods and feature overview: https://upstash.com/docs/redis/sdks/ratelimit-ts/methods and https://upstash.com/docs/redis/sdks/ratelimit-ts/gettingstarted
- Kong Rate Limiting Advanced and AI Rate Limiting Advanced: https://developer.konghq.com/plugins/rate-limiting-advanced/ and https://developer.konghq.com/plugins/ai-rate-limiting-advanced/
- OpenMeter entitlement notifications and grants: https://openmeter.io/docs/integrations/notifications/entitlements and https://openmeter.io/docs/billing/entitlements/grant
- Unkey product changelog and first-party rate-limit material: https://www.unkey.com/changelog and https://www.unkey.com/blog/why-we-built-unkey
- Envoy RLS / RLQS: https://www.envoyproxy.io/docs/envoy/latest/api-v3/service/ratelimit/v3/rls.proto and https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/rate_limit_quota_filter
