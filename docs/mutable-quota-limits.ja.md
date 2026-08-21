# Mutable quota limit

[English](mutable-quota-limits.md) | [日本語](mutable-quota-limits.ja.md)

同じaccounting bucketにreserved / consumed usageがすでに存在する途中で、applicationがeffective quotaを変更することがあります。代表例はplan upgrade / downgrade、trial expiry、一時的なoperational override、tenant固有limitの変更です。

`mcp-usage-control` は渡された `budget.limit` を、**そのreserve attemptに対するeffective admission ceiling** として扱います。accounting bucketへ永久的なlimit定義を保存する仕組みではありません。同じ `budget.key` に紐づくauthoritative usageはそのまま維持します。

Free / Plusの月次weighted creditsを一連で確認する場合は [サブスク型MCP creditsの実装パターン](subscription-credits.ja.md) を参照してください。

## 同じkeyは同じaccounting bucket

1つの `budget.key` に対して:

- effective limitを上げても既存のreserved / consumed usageは維持し、増えたheadroomだけ新たに利用可能にする
- effective limitを下げても既存usageは維持し、usageがlower limit以上ならnew admissionをdenyする
- limit decreaseで既存reservationをrefund / rewrite / cancel / shrinkしない
- activeなpending / cost-liable reservationはそのまま通常のliability / renewal / settlement lifecycleを継続できる
- plan / override変更だけを理由にbudget keyを変えない。key変更はapplicationが本当に別accounting bucket / windowを意味する場合だけ行う

Storeはauthoritative usage stateとcurrent requestで渡されたlimitからadmissionを判断します。概念的には次です。

```text
remaining = max(0, effectiveLimit - authoritativeUsedOrReserved)
```

つまりconfigured limitはpolicy inputで、authoritative usageはStore stateです。

## Upgrade例: Free -> Pro

`month:user-42:2026-08` にすでに80 unitsあるとします。

```text
Free limit = 100
Pro limit  = 300
```

upgrade後も同じkeyを使い、limit `300` をquoteします。既存80 unitsはそのままcountされ、新しいheadroomは220 unitsです。本当に別bucketを作る意図がない限り、allowanceを増やすためだけに `month:user-42:2026-08:pro` のような新keyを作ってはいけません。

## Downgrade例: Pro -> Free

同じbucketに180 unitsある状態でeffective limitが300から100へ下がるとします。

同じkeyのままlimit `100` をquoteします。既存180 unitsはauthoritative usageとして保持します。policyまたはaccounting windowが正当に変わるまでnew admissionはremaining 0でdenyされます。downgradeによってbucketを100へ書き換えたり80 unitsをrefundしたりしません。

## Trial expiry

trialで既存monthly quotaを一時的に増やしているなら、trial expiry時は通常 **同じmonthly key** のeffective limitを下げます。trial中に使ったusageもそのaccounting windowでは引き続きcountします。

product semanticsとしてtrialを本当に独立budgetとして扱うなら、usageが積み上がってからkeyを切り替えるのではなく、最初から別budgetとしてmodelingします。

## Temporary override

temporary increaseは同じkeyにhigher limitをquoteすることで適用できます。override終了後はnormalなlower limitへ戻します。すでに発生したusageは変わりません。

このprojectはoverride自体、そのexpiry、administrator identity、entitlement historyを保存しません。これらはapplication policyの責務です。

## Concurrent old/new policy view

`UsageStore` が提供するのはatomic accountingであり、**distributed policy-version consensusではありません**。

同じkeyについて2つのapplication instanceが異なるeffective limitを同時に渡した場合、それぞれのtransactionはauthoritative usageを、そのcallerが渡したlimitと比較します。たとえばusageがすでに `1` なら:

- limit `1` を渡すcallerはdenyしなければならない
- staleなinstanceがまだlimit `2` を渡していれば、追加1 unitをadmitできる場合がある

これは意図したcontractで、portable conformance runnerでもcoverします。そのためstrictなdowngrade cutoverが必要なら、新limitでtrafficを受ける前にapplication側でpolicy rolloutを十分consistentにする必要があります。central policy read、versioned configuration、coordinated rollout、routing / availability controlなど、applicationに合う方式を使います。

`mcp-usage-control` はStoreをsubscription databaseやdistributed configuration serviceへ変えません。

## Limit変更中のactive reservation

limit changeが影響するのは **future admission decision** です。すでにcommit済みのreservation contractを書き換えません。

- pending reservationはreservedのまま
- cost-liable reservationはconservativeにchargedのまま
- renewal時にnew limitでre-price / re-admitしない
- settlementは通常どおり `reservedUnits - actualUnits` だけreleaseし、actual usageを保持する

administrative cancellationやentitlement revocationが必要なら、それは別のapplication control planeです。authoritative usage accountingを暗黙にrewriteしてはいけません。

## Key変更でusageをresetしない

`budget.key` を変えると別accounting bucketになります。同じaccounting windowを継続する意図なのに、plan change、downgrade、temporary override、administrative correctionのshortcutとしてkey rotationを使ってはいけません。

同様に `MemoryUsageStore.retireBudgetKey()` は、accounting windowが永久に終了し、その同じwindowとしてkeyを再利用しない場合だけ使います。quota resetやplan-change APIではありません。

正当なkey変更の例は、application-ownedなwindowが本当に新しくなる場合です。

```text
month:user-42:2026-08
month:user-42:2026-09
```

windowがいつ変わるかはapplicationが所有し、Store implementationは推測しません。

## Portable evidence

`mcp-usage-control/conformance` runnerはcompatibleなStoreに対して同じmutable-limit contractを検証します。

- 既存usageを維持したlimit increase
- reservationがpending / cost-liableの途中でのlimit decrease
- decrease後もsettled / consumed usageをrefundしない
- stricter limitとstale higher limitを同時に提示するcaller

built-in CIではこのcontractをMemory、Redis、Cloudflare Durable Objects（local workerd）、Firestore（Local Emulator Suite）へ同じ形で実行します。
