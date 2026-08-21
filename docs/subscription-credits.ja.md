# サブスク型MCP creditsの実装パターン

[English](subscription-credits.md) | [日本語](subscription-credits.ja.md)

たとえば、次のような料金プランを考えます。

- Free: 1か月50 MCP credits
- Plus: 1か月100 MCP credits
- `search`: 1 credit
- `summarize`: 3 credits
- `ai_analyze`: 5 credits
- `browser_action`: 10 credits

`mcp-usage-control` なら、この仕組みを安全にenforceしつつ、MCPUsage自体をsubscription systemにはしない構成にできます。planやentitlementの正本、product configはapplication側に残し、そのtrustedな結果をMCPUsageがconcurrency-safeなreserve / liability / settlementへ変換します。

## 推奨する責務の境界

```text
subscription / entitlement service       application config
              \                         /
               \                       /
                -> trusted plan + limits + tool costs
                              |
                              v
                    UsagePolicy.quote()
                              |
                              v
                 MCPUsage enforcement Store
                 reserve -> liable -> settle
                              |
                  optional safe telemetry
                              |
                              v
            analytics / billing / history ledger
```

一番下のledgerはoptionalで、enforcementとは別物です。privacy-safeなeventやapplication側のbusiness recordを保存しても構いませんが、**「今このMCP operationを開始してよいか」を決めるauthoritative sourceにはしません。**

MCPUsageは、subscription truth、pricing catalog、payment collection、durableなcustomer usage history、invoice、billing / financial ledgerを所有しません。これらはapplication / product側の責務です。

## 月次weighted creditsの完全な例

weighted-credit helperでtrustedなin-memory configをvalidateし、window-key helperで月次accounting identityを安定して生成します。

```ts
import {
  MemoryUsageStore,
  UsageControl,
  createWeightedCreditsPolicy,
  createWindowedBudgetKey,
  defineWeightedCreditPolicyConfig,
} from 'mcp-usage-control';

const creditConfig = defineWeightedCreditPolicyConfig({
  tools: {
    search: 1,
    summarize: 3,
    ai_analyze: 5,
    browser_action: 10,
  },
  plans: {
    free: { limits: { monthly: 50 } },
    plus: { limits: { monthly: 100 } },
  },
  unknownTool: 'deny',
});

const monthlyKey = createWindowedBudgetKey({
  period: 'calendar-month',
  timeZone: 'Asia/Tokyo',
  namespace: 'credits',
  clock: Date.now,
});

const policy = createWeightedCreditsPolicy({
  config: creditConfig,

  // application側が所有するtrustedなentitlement truthを解決する。
  // server-side cache/serviceを読んでもよいが、その正本をMCPUsageは所有しない。
  resolvePlan: async request =>
    await applicationEntitlements.currentPlan(request.principal.id),

  budgets: ({ request, limit }) => ({
    key: monthlyKey.key({
      scope: 'user',
      id: request.principal.id,
    }),
    limit: limit('monthly'),
  }),
});

const control = new UsageControl(new MemoryUsageStore(), policy);

const request = {
  operationId: 'browser-action:42:request-0001',
  principal: { id: '42' },
  tool: 'browser_action',
  args: {},
};

const admission = await control.reserve(request);
if (!admission.allowed) {
  throw new Error(`usage denied: ${admission.reason}`);
}

await admission.lease.markLiable();
await performBrowserAction();
await admission.lease.settle(10, 'success');
```

Tokyo timezoneで2026年8月のuser `42`なら、たとえば次のkeyになります。

```text
credits:month:tz=Asia%2FTokyo:user:42:2026-08
```

4つのtoolはすべて同じscalar credit bucketを共有し、違うのはquoteされる `units` だけです。

たとえば `browser_action` は10 credits、`search` は1 creditですが、どちらもPlusの100 creditsから消費します。Storeがadmissionをatomicに処理するため、残りcreditが少ない状態でconcurrent requestが来ても同じ残量を二重に使えません。

上の `MemoryUsageStore` は短いexample用です。本番でprocess restartをまたいでstateを保持する、または複数instanceで共有する必要がある場合は、Redis / Cloudflare Durable Objects / Firestoreなどのproduction Storeを使います。

## Entitlement lookupはapplication側に残す

`resolvePlan` はintegration seamであって、subscription databaseではありません。

application側の責務として自然なのは次です。

- trustedなserver-side stateから現在の `free` / `plus` を決める
- trialやoperator overrideでeffective plan / limitを変えるか判断する
- review済みのtool cost / plan limit configを読み込み、各instanceへ配布する
- configのcache / version / rollout方法を決める

MCPUsageへ渡すのは、その結果として確定したtrusted planとlimitです。RevenueCat、Stripe、App Store、Google Play、Firebase Remote Configなどのcommercial subscription providerの正本をMCPUsageが直接所有する構成にはしません。

## 同じ月の途中でFree -> Plusへupgradeする

Free userが8月に50 credits中30 creditsをすでに消費し、その途中でPlusへupgradeしたとします。

upgrade前:

```text
key   = credits:month:tz=Asia%2FTokyo:user:42:2026-08
limit = 50
used  = 30
headroom = 20
```

upgrade後は **同じkeyのまま** Plus limitをquoteします。

```text
key   = credits:month:tz=Asia%2FTokyo:user:42:2026-08
limit = 100
used  = 30
headroom = 70
```

keyに `plus` を足してはいけません。8月分を新規bucketとして作り直すこともしません。Storeはすでに消費した30 creditsをauthoritativeなusageとして維持し、future admissionだけを新しいeffective limitで判断します。

詳しいcontractは [Mutable quota limit](mutable-quota-limits.ja.md) を参照してください。

## Downgrade / trial expiry

逆方向も同じ考え方です。effective limitが100の間に80 credits使ったあと、同じ月の途中でFreeの50 creditsへdowngradeしたとします。

同じkeyのままlimit `50` をquoteします。

```text
used  = 80
limit = 50
remaining admission capacity = 0
```

既存の80 creditsをrefundしたり、50へ切り詰めたり、usage stateを書き換えたりしません。正当なnew windowに切り替わるか、policyが再び変わるまでnew reservationはdenyされます。

trialが通常の月次allowanceを一時的に増やすだけなら、trial expiryでも通常は同じmonthly keyのeffective limitを下げます。trialを本当に独立したcredit poolとして扱うproduct仕様なら、usageが積み上がったあとでkeyを切り替えるのではなく、最初から別budgetとしてmodelingします。

## 正しい月替わり

calendar windowが変わることは、accounting keyを変える正当な理由です。

同じhelper設定なら:

```text
8月: credits:month:tz=Asia%2FTokyo:user:42:2026-08
9月: credits:month:tz=Asia%2FTokyo:user:42:2026-09
```

Storeが時計を監視してcounterをその場でresetするわけではありません。applicationが9月の新しいkeyをderiveし、それが本当に別のaccounting bucketになります。

`namespace`、`period`、timezone設定、scope名、subject ID形式を変えることもaccounting identityの変更です。単なるconfig変更ではなくquota-key migrationとして扱ってください。詳しくは [利用枠の期間を表すbudget key](accounting-window-keys.ja.md) を参照してください。

契約更新日を起点にするsubscription anniversaryやfiscal calendarはhelperへ内蔵していません。calendar day/month以外のbusiness windowでは、application policy側でstableな `Budget.key` を明示的にderiveします。

## Dynamic cost: safe maximumをreserveしてactualをsettleする

実行が終わるまで正確なcostが分からないtoolもあります。たとえばdocument analysisが処理量によって1〜20 creditsになるケースです。

cost-bearing workを始める前にconservativeな最大値をreserveし、終了後にactual amountをsettleします。

```ts
import {
  MemoryUsageStore,
  UsageControl,
  type UsagePolicy,
  type UsageRequest,
} from 'mcp-usage-control';

const SAFE_MAX_CREDITS = 20;

const dynamicPolicy: UsagePolicy = {
  async quote(request: UsageRequest) {
    const plan = await applicationEntitlements.currentPlan(request.principal.id);
    const monthlyLimit = plan === 'plus' ? 100 : 50;

    return {
      decision: 'allow',
      units: SAFE_MAX_CREDITS,
      budget: {
        key: monthlyKey.key({ scope: 'user', id: request.principal.id }),
        limit: monthlyLimit,
      },
    };
  },
};

const dynamicControl = new UsageControl(new MemoryUsageStore(), dynamicPolicy);
const dynamicRequest: UsageRequest = {
  operationId: 'dynamic-analysis:42:request-0001',
  principal: { id: '42' },
  tool: 'dynamic_analysis',
  args: {},
};
const admission = await dynamicControl.reserve(dynamicRequest);

if (!admission.allowed) {
  throw new Error(`usage denied: ${admission.reason}`);
}

await admission.lease.markLiable();
const result = await performDynamicWork();

// actualCreditsはnon-negative integerかつ現在reserved済みの範囲内。
await admission.lease.settle(result.actualCredits, 'success');
```

settlement時に予約した最大値とactualの差分がreleaseされます。実際には最大20 credits発生し得るのに、平均値だけを先にreserveして、未承認の追加costまで処理してしまう形にはしません。

### 最大値を先にreserveするのが現実的でない場合

worst-case reservationが大きすぎる、またはworkがbatch単位で自然に増えていく場合は、`ProgressiveUsageStore` を実装するStoreでoptional progressive reservation growthを使えます。

```ts
const currentPlan = await applicationEntitlements.currentPlan(dynamicRequest.principal.id);
const currentMonthlyLimit = currentPlan === 'plus' ? 100 : 50;

const growth = await admission.lease.grow({
  incrementId: 'batch-0042',
  additionalUnits: 10,
  budgets: [
    {
      key: monthlyKey.key({ scope: 'user', id: dynamicRequest.principal.id }),
      limit: currentMonthlyLimit,
    },
  ],
});

if (!growth.accepted) {
  // additional metered workへ入る前にstopする。
}
```

追加costを発生させる**前**に各growthをauthorizeします。`incrementId` はstableにし、ACKがambiguousなら別incrementを作らず同じgrowth attemptをexact retryします。詳しくは [Progressive MCP growth](progressive-mcp-integration.ja.md) を参照してください。

## Scalar creditsとvector usageの使い分け

productがtool間の交換比率を意図的に1つのcredit通貨として定義しているなら、**scalar credits** を使います。

```text
search = 1 credit
summarize = 3 credits
ai_analyze = 5 credits
browser_action = 10 credits
```

これらはすべて同じfungible allowanceを消費するため、scalar `UsagePolicy` / `UsageControl` が自然です。

一方、1 logical operationが独立した意味・上限を持つ異種dimensionを同時に消費する場合は **vector usage** を使います。

```text
requests = 1
input_tokens = 12,000
GPU_ms = 850
```

vector APIがあるからといって異種unitを無理に合算しません。逆に、product側が交換比率を定義していないのにfake credit conversionを作る必要もありません。判断基準は次です。

> productが1つの意図したexchange rateでunitを相互交換可能として扱うならscalar credits。dimensionごとに独立したlimit / 意味があり、それらをatomicにenforceする必要があるなら `VectorUsagePolicy` / `VectorUsageControl`。

詳しくは [Atomic heterogeneous usage vector](vector-usage.ja.md) を参照してください。

## Config rolloutのconsistency

Storeがserializeするのはauthoritative usage updateです。各callerが使うconfigの**distributed consensus**までは提供しません。

あるinstanceではPlus=100 credits、staleな別instanceではPlus=120 creditsのままなら、同じkeyに対して異なるceilingでadmissionを判断する可能性があります。strictなdowngradeやtool weight変更を一斉cutoverしたい場合は、application側で次のようなrolloutを設計します。

- centrally read / versioned policy config
- bounded cache TTL + coordinated invalidation
- stale instanceがtrafficを受けないdeployment sequencing
- strict cutover中のrouting / availability control

`defineWeightedCreditPolicyConfig()` は1 policy instanceへ渡したobjectをsnapshotするため、caller objectの後続mutationでローカル設定が勝手に変わることは防げます。ただしprocess間のconfig distribution / version consistencyはapplication側の責務です。

## Enforcement stateは利用履歴やbilling ledgerではない

Storeが保持するのは、concurrency-safeなenforcement、replay protection、reservation lifecycle、expiry recovery、settlementに必要なauthoritative stateです。customer-facing history databaseでも、financial ledgerでもありません。

「今月のtool callを全部表示したい」、invoice、payment reconciliation、revenue recognition、audit export、長期analyticsなどが必要なら、その用途に必要なretention / privacy / durabilityを持つ別のapplication-owned systemへ記録します。

Store内部のkeyをscrapeしてfinancial ledgerを復元したり、optional telemetryをsecond enforcement truthにしたりしないでください。

## 誰が何を持つか

| Concern | Owner |
| --- | --- |
| Current plan / entitlement | Application / subscription system |
| Tool credit weight | Application config |
| Planごとのmonthly allowance | Application config |
| Calendar day/month key | Application + `createWindowedBudgetKey()` |
| Atomic quota admission | MCPUsage Store |
| Pending -> liable -> settled lifecycle | MCPUsage |
| Retry / idempotency accounting | MCPUsage + application-stable operation identity |
| Subscription purchase / payment collection | MCPUsageのscope外 |
| Invoice / financial ledger | MCPUsageのscope外 |
| Durableなcustomer usage history / analytics | 別のapplication-owned store |

## 関連ドキュメント

- [利用枠の期間を表すbudget key](accounting-window-keys.ja.md)
- [Mutable quota limit](mutable-quota-limits.ja.md)
- [MCP integration](mcp-integration.ja.md)
- [Progressive MCP growth](progressive-mcp-integration.ja.md)
- [Atomic heterogeneous usage vector](vector-usage.ja.md)
- [API reference](api-reference.ja.md)
