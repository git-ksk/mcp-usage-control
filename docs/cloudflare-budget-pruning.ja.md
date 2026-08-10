# Cloudflare historical budget pruning

windowed usage policyでは、たとえば `tenant:user:daily:2026-08-11` のようにapplication windowをbudget keyへ含めることがあります。そのため古いwindowの `budgets` rowがDurable Object SQLiteへ残ります。

`mcp-usage-control-cloudflare` は、どのwindowがobsoleteかを**推測しません**。retention policyはapplication/operator側の責務です。optional maintenance APIは、callerがhistoricalとして明示的に指定したexact budget keyだけを削除対象にします。

## Safety model

historical pruningは通常のusage enforcementから分離しています。

- 1 invocationあたりhistorical candidateは最大64件。
- protected/current keyも1 invocationあたり最大64件。
- raw budget keyはCloudflare HTTP boundaryを越える前にSHA-256 hash化。
- protected/currentとして指定したkeyはそのinvocationでは削除しない。
- `pending` / `liable` reservationから参照されているkeyは削除しない。
- lease timestampがexpiredでも、normal recovery前のactive rowは保守的にactive扱いしてpruningをblockする。
- settled/tombstoned reservationはsettlement replayでbudget balanceを更新しないためpruningをblockしない。
- pruningはreservation / settlement / replay / expiry-recovery stateを変更しない。
- maintenance endpoint failureはfail-close。

このAPIは、`used` が正のhistorical budget rowも明示的に削除できます。applicationが「そのexact accounting windowはcurrent enforcementにもう参加しない」と判断した場合にhistorical stateを回収するためのoperationです。

## Separate maintenance gateway

通常のMCP usage gatewayとは別routeにし、可能ならcredential / authorization policyも分けてください。

```ts
import { createCloudflareBudgetMaintenanceGateway } from 'mcp-usage-control-cloudflare/maintenance';

const maintenanceHandler = createCloudflareBudgetMaintenanceGateway({
  namespace: env.USAGE_CONTROL,
  domainName: 'production',
  authorizeMaintenance: request =>
    request.headers.get('authorization') === `Bearer ${env.USAGE_MAINTENANCE_TOKEN}`,
});
```

default pathは `/v1/usage-store-maintenance` です。allow-all policyで公開しないでください。

1つのWorkerで、通常usage requestは `createCloudflareUsageStoreGateway()` / `createReconciliableCloudflareUsageStoreGateway()`、maintenance pathだけ `createCloudflareBudgetMaintenanceGateway()` へrouteできます。

## Client usage

exact historical candidateと、絶対に残すcurrent/retained keyを渡します。

```ts
import { pruneRemoteCloudflareHistoricalBudgets } from 'mcp-usage-control-cloudflare/maintenance';

const result = await pruneRemoteCloudflareHistoricalBudgets(
  {
    endpoint: process.env.MCP_USAGE_CLOUDFLARE_MAINTENANCE_URL!,
    headers: () => ({
      authorization: `Bearer ${process.env.MCP_USAGE_CLOUDFLARE_MAINTENANCE_TOKEN!}`,
    }),
  },
  {
    historicalBudgetKeys: oldWindowKeys,
    protectedCurrentBudgetKeys: currentWindowKeys,
  },
);
```

requested historical candidateは必ず次のどれか1つに分類されます。

- `prunedKeys` — row削除済み。
- `blockedProtectedKeys` — protected/currentにも指定されている。
- `blockedActiveKeys` — pending/liable reservationが参照中。
- `missingKeys` — budget rowが存在しない。

maintenance replyが不正またはcandidateを欠落させている場合は、推測せずrejectします。

## Historical keyの選び方

retention semanticsはapplication-ownedのままです。安全な運用手順は次です。

1. budget keyを生成している同じapplication logicからcompleted accounting windowを特定する。
2. current windowとpolicy上必要なreconciliation/audit horizonを `protectedCurrentBudgetKeys` に残す。
3. application-defined horizonより古いexact windowだけをprune candidateにする。
4. 最大64件ずつbatch送信する。
5. historicalであることを引き続き確認できるkeyだけretryする。active-blocked keyはreservationがsettle/recoverした後に再検討する。
6. maintenance failureはbusiness `quota_exceeded` と分けてmonitorする。

hashを推測してcandidateを作ったり、applicationから任意のDurable Object stateをscanして削除対象を決めたりしないでください。

## Active / expired reservation

maintenanceは意図的にreservation recoveryを実行しません。budgetが `pending` / `liable` rowから参照されている限り、lease timestampが過ぎていてもpruningをblockします。

これによりmaintenanceがnormal conservative recovery semanticsを変更しません。通常のusage-control pathでexpiry recoveryさせた後、applicationがまだobsoleteと判断するexact historical candidateだけを後からretryしてください。

## Replay / idempotency

古いbudget rowを削除してもreservation tombstoneは削除しません。そのためretained settled reservationのsettlement replay behaviorは維持されます。

通常のtombstone/idempotency retention horizon経過後は、old logical operationがreservation tombstoneで保護されなくなる場合があります。historical budget rowをpruneしたことを理由に、古いwindow keyやoperation IDを再利用しないでください。

## Bounded work

hard limit 64件によりpruningはincrementalです。各candidateについてpoint lookup/deleteとactive-reservation reference checkを1 Durable Object transaction内で行います。大規模retention sweepは1回のunbounded requestにせず、application/operator管理の複数invocationへ分割してください。
