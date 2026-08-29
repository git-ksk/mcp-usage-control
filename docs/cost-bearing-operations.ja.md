# Cost-bearing operation

[English](cost-bearing-operations.md) | [日本語](cost-bearing-operations.ja.md)

このdocumentは、AI inference、paid API、document processingなど、実際のprovider costが発生し得るworkに対するv0.11のaccounting contractを定義します。

v0.11では意図的にsurfaceを増やしません。**新しいpublic accounting primitiveは不要**と判断します。既存のvector reservation、liability、progressive growth、renewal、settlement、idempotency contractを正しいexecution boundaryで組み合わせれば、cost-bearing operationを安全に表現できます。

## 固定するlifecycle

cost-bearing operationは次の順序で扱います。

```text
trusted caller + application-owned accounting scopeを解決
  -> bounded maximum exposureをquote
  -> 必要な全dimensionをatomic reserve
  -> billable dispatch直前にmark liable
  -> provider workをdispatch
  -> additional billable exposureの前にgrow
  -> authoritative work / usage evidence待ちの間はrenew
  -> authoritative actual usageでsettle
```

reserved exposureをrefund / releaseできるのは、applicationが「billable effectが発生していない」と証明できる場合だけです。dispatch後のprovider error、timeout、client cancellation、ACK欠落だけではcost 0の証拠になりません。

## 平均costではなく最大露出をreserveする

`mcp-usage-control` は、settlementでsuccessfully reserved capacityを超えるactual usageを受け入れません。これは回避すべき制約ではなくsafety propertyです。

variable-cost provider workではdispatch前に次のどちらかを行います。

1. そのattemptで発生し得るdefensible maximum exposureをreserveする。
2. initial bounded amountをreserveし、後続provider actionが追加costを発生させる**前に** `grow()` する。

actual costがaverage / expected costを超え得るなら、その平均値はhard budget boundとして使えません。

providerがpre-growthできない形でcostを増やし続け、defensible maximumも定義できない場合、このusage reservationをhard provider-spend capとして宣言してはいけません。

## 単位が違うものはvector dimensionを分ける

count quotaとprovider costは意味の違う単位なので、1つのsynthetic scalarへ足し合わせません。

例:

```ts
const policy = {
  quote() {
    return {
      decision: 'allow',
      dimensions: [
        {
          key: 'operations',
          units: 1,
          budgets: [{ key: 'count:scope:workspace-42', limit: 100 }],
        },
        {
          key: 'provider_cost_microunits',
          units: 1_000,
          budgets: [{ key: 'cost:scope:workspace-42', limit: 50_000 }],
        },
      ],
    };
  },
};
```

provider costにはmicrounitなど、applicationがscaleを明示したsafe integer / fixed-scale unitを使います。currency conversion、provider pricing table、tax、billing period、financial reconciliationはapplication-ownedです。

## Caller identityとaccounting scopeは別概念

`Principal` はoperation idempotency / isolationに使うtrusted caller identityのままです。一方、operation costを負担するbudget ownerはcallerと同一とは限りません。

applicationはquote前にauthoritative accounting scopeを解決し、application-ownedのopaque budget keyへencodeします。たとえば複数board memberが別々のprincipalでも、全員が次のbudgetを消費できます。

```text
cost:scope:board-owner-42
```

これによって`mcp-usage-control`がsubscription ownership、membership、entitlement、billingのauthorityになるわけではありません。applicationがそれらを先に解決してからpolicy / budget keyを作ります。

既存の `Budget.key` がapplication-selected accounting bucketを十分表現できるため、v0.11ではcoreへ `subscriptionId`、`billingAccountId`、`budgetScopeId` のような新fieldを追加しません。

## Liability boundary

最初にprovider costが発生し得るactionの直前で `markLiable()` を呼びます。

```text
reserve成功
  -> markLiable成功
  -> provider dispatch可
```

`markLiable()` が失敗、またはACKがambiguousな場合、applicationがcallした事実だけではauthoritative liability transition成功の証明になりません。local intentだけを根拠にbillable dispatchへ進まず、authoritativeにsafeなpathが得られるまでfail closedにします。

reservationがliableになった後は、expiryしても自動refundになりません。actual usageがunknownならreserved exposureを保守的に保持します。

## Provider retryは追加露出として扱う

独立してcostを発生させ得るprovider retryはfree retryではありません。

次のbillable attempt前に:

```text
first attemptでcostが発生した可能性あり
  -> retry分のmaximum exposureをreserve / grow
  -> growthがauthoritatively acceptedの場合だけ
  -> retry dispatch
```

vector reservationでは、logical operationをcountとして1回だけ扱うproduct policyなら、count dimensionは0 growth、provider-cost dimensionだけをgrowできます。

`grow()` がdenyされた場合、追加provider attemptをdispatchしてはいけません。growthでambiguous provider/storage errorが出ると、`UsageLease` / `VectorUsageLease` はunresolved growthをpinし、authoritative resultを得るまで同じincrementのexact retryだけを許します。growth unresolved中に新しいbillable workへ進みません。

provider / business retry policy自体はlibrary外です。usage idempotencyはdestructive / non-idempotentなprovider operationのreplay safetyを保証しません。

## Settlementとproven-no-effect release

settlementはreservationをauthoritativeにcloseするaccounting operationです。

canonical outcome vocabularyを使います。代表的なmapping:

| 状況 | Usage treatment | Canonical outcome |
| --- | --- | --- |
| billable dispatch前にreject | no effectが証明できれば0 settle | `pre_dispatch_rejected` / `pre_dispatch_no_effect` |
| provider effectなしを明示証明 | proven actual（0含む）でsettle | `proven_no_effect` |
| authoritative usage付きでprovider work完了 | actual dimensionでsettle | `completed` |
| dispatch済みだがfinal cost unknown | reserved exposure内で保守的にretain / settle | `dispatched_conservative` |
| dispatch後cancel | cost 0を推測しない | `cancelled_after_dispatch` |

provider exceptionがthrowされたことだけで `proven_no_effect` にしてはいけません。billable side effectが無いことを示すprovider-specific evidenceが必要です。

settlementはreserved capacityを超えるactual usageを受け入れません。providerがreserved amountより大きいusageを返した場合、pre-dispatch boundが不足していたことを示します。後からlimitを書き換えてsilent under-accountingするのではなく、application設計を修正します。

## Delayed provider usage evidence

providerによってはprimary resultより後でfinal usageが確定します。

authoritative usage evidenceがreservationを保持できる間に取得できる場合:

1. authoritative operationをactiveのまま維持する。
2. 必要に応じてleaseをrenewする。
3. final bounded usage evidence取得後にsettleする。

reservationをauthoritatively保持できなくなった後にしかevidenceが来ない場合、initial reservationがdefensible maximumを既にcoverしている必要があり、usage pathはconservativeに維持します。durableなpost-hoc financial reconciliationはapplication / billing ledgerの責務であり、`mcp-usage-control`の責務ではありません。

## Rate limit / circuit breaker / kill switchとの合成

cost reservationは他controlと組み合わせますが、それらの代替にはなりません。

代表例:

```text
application kill switch
  -> provider/global circuit breaker / health policy
  -> short-window rate limit
  -> entitlement / accounting-scope解決
  -> mcp-usage-control atomic reserve
  -> liability + billable dispatch
```

controlがlocalかauthoritativeかで厳密な順序は変わり得ますが、external availability policyによってaccounting Store failureをunmetered allowへ変えてはいけません。

provider health、remote configuration、entitlement resolution、retry/backoff policyはapplication-ownedです。

## Observabilityとprivacy

既存のlifecycle event / operational helperを使い、reserve accepted/denied、settlement、recovery、storage errorなどboundedなsignalを扱います。

prompt、receipt image/text、provider payload、credential、raw tool arguments、customer identifier、無制限なuser contentをevent metadataへコピーしません。unique operation / principal / reservation / budget identifierをmetrics labelにしません。

operational telemetryはaccounting authorityでもfinancial ledgerでもありません。

## v0.11 proofで確認すること

focused core proofでは次をcoverします。

- 異なるcallerが1つのapplication-selected shared accounting scopeを競合利用する。
- count + provider costをatomic vector reserveする。
- dispatch前にbounded maximum exposureをreserveする。
- settlementがreserved capacity内に収まり、unused exposureをreleaseする。
- pre-dispatch proven-no-effectをreleaseする。
- 2回目のbillable provider attempt前にgrowthする。
- growth deny時にretry dispatchを止める。
- liable / post-dispatch ambiguityではreserved exposureを保守的に保持する。
- stable logical operation identityでduplicate reservationを防ぐ。

provider-specific Store conformanceは引き続きunderlying atomic vector / growth / expiry behaviorを証明します。cost-bearing proofは2つ目のStore contractを作りません。

## v1 boundary

v1で採用するcontractは次です。

**application-owned entitlement / scope / pricing -> existing atomic vector reservation -> explicit liability -> bounded pre-dispatch growth -> authoritative settlement**

provider-specific billing abstraction、financial ledger、subscription model、新しいcost-bearing public primitiveはv1 core surfaceへ追加しません。将来、現行contractで表現できない具体的なsafety gapが証明された場合だけ再検討します。
