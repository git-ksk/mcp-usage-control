# 利用枠の期間を表すbudget key

[English](accounting-window-keys.md) | [日本語](accounting-window-keys.ja.md)

`mcp-usage-control` のStoreは、時計を監視して「月が変わったからquotaをresetする」といった処理をしません。どの利用枠をauthoritativeなbucketとして使うかは、applicationが `Budget.key` で選びます。

日次・月次のような一般的なcalendar windowについては、`createWindowedBudgetKey()` を使うと、subscriptionやbilling calendar、Store stateをcoreへ持ち込まずに、timezone-awareなkeyをdeterministicに作れます。

## 月次quotaの例

```ts
import { createWindowedBudgetKey } from 'mcp-usage-control';

const monthly = createWindowedBudgetKey({
  period: 'calendar-month',
  timeZone: 'Asia/Tokyo',
  namespace: 'credits',
});

monthly.key({
  scope: 'user',
  id: '42',
  now: new Date('2026-08-22T03:00:00+09:00'),
});
// credits:month:tz=Asia%2FTokyo:user:42:2026-08
```

`namespace`、`scope`、`id` はcomponentごとにencodeされます。たとえばIDに `:` が含まれていても、別のscope/id構成と同じkeyへ衝突しません。

## 日次quotaの例

```ts
const daily = createWindowedBudgetKey({
  period: 'calendar-day',
  timeZone: 'America/New_York',
  namespace: 'requests',
});

const key = daily.key({ scope: 'tenant', id: 'acme', now: Date.now() });
```

日付は指定したtimezone上で判定します。DSTや月末・年末などのcalendar boundaryは、実行環境のICUが提供するtimezone情報に従います。

## Clockを差し替える

同じcall siteで毎回 `now` を渡さず、testやdeterministicな処理で時刻を固定したい場合はtrusted clockを指定できます。

```ts
const monthly = createWindowedBudgetKey({
  period: 'calendar-month',
  timeZone: 'UTC',
  namespace: 'credits',
  clock: () => fixedNow,
});
```

`key({ now })` を指定した場合はそちらが優先されます。それ以外はpure helperであり、Store stateを書き換えたり、古いbucketを削除したり、月替わり処理をscheduleしたりはしません。

## Weighted creditsと組み合わせる

```ts
import {
  createWeightedCreditsPolicy,
  createWindowedBudgetKey,
} from 'mcp-usage-control';

const monthly = createWindowedBudgetKey({
  period: 'calendar-month',
  timeZone: 'Asia/Tokyo',
  namespace: 'credits',
  clock: Date.now,
});

const policy = createWeightedCreditsPolicy({
  config: {
    tools: { search: 1, summarize: 3, ai_analyze: 5, browser_action: 10 },
    plans: {
      free: { limits: { monthly: 50 } },
      plus: { limits: { monthly: 100 } },
    },
    unknownTool: 'deny',
  },
  budgets: ({ request, limit }) => ({
    key: monthly.key({ scope: 'user', id: request.principal.id }),
    limit: limit('monthly'),
  }),
});
```

同じ月の途中でFreeからPlusへ変わっても、budget keyはそのままです。変わるのはeffective limitだけなので、それまでに消費したauthoritative usageは保持されます。翌月になれば新しいkeyが導出されます。

## 設定変更はaccounting identityの変更

次の値を変えるとaccounting identityも変わり、新しいauthoritative stateを選ぶ可能性があります。

- `namespace`
- `period`
- 設定したtimezoneの文字列
- `scope` の名前や構造
- `id` の形式

特にtimezoneはkeyへ意図的に含めています。`UTC` から `Asia/Tokyo` へ変えた場合はもちろん、同じtimezoneを表す別aliasへ表記だけ変えた場合でも、別のkey identityになります。rollover境界だけ変わったのに既存bucketを半端に再利用するより、安全側へ倒すためです。

この種の変更は、単なるconfig変更ではなく**quota key migration**として扱ってください。新しい利用枠へ切り替える意図がない限り、window途中で安易に変更しない方が安全です。

## Application側に残る責務

このhelperは次を実装しません。

- subscriptionの更新日を起点にするanniversary cycle
- 任意のfiscal calendar
- RevenueCat / Stripe / Firebase / Remote Config / fileの読み込み
- entitlementの正本管理
- 古いwindowのretire
- billing/history ledger

契約更新日ベースやprovider固有のperiodが必要な場合は、window resolverをapplication側に残し、`Budget.key` を明示的に組み立ててください。Storeへ渡すのは、最終的に決まったstable keyとeffective limitだけです。
