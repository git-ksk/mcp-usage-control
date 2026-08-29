# Operational usability

[English](operational-usability.md)

v0.10では、second accounting truthを作らずに運用しやすくする小さなprovider-neutral helperを追加します。enforcement stateのauthoritative sourceは、引き続き設定された `UsageStore` です。

## Operational snapshot

`UsageOperationalMonitor` をruntimeとStoreの両方へ同じbest-effort observerとして渡します。

```ts
import { MemoryUsageStore, UsageControl } from 'mcp-usage-control';
import {
  UsageOperationalMonitor,
  createUsageRuntimeIdentity,
} from 'mcp-usage-control/operational';

const monitor = new UsageOperationalMonitor(
  createUsageRuntimeIdentity({
    provider: 'memory',
    capabilities: ['progressive', 'vector', 'reconciliation'],
  }),
);

const store = new MemoryUsageStore({ observer: monitor });
const control = new UsageControl(store, policy, { observer: monitor });

console.log(JSON.stringify(monitor.snapshot()));
```

snapshotに含まれるのは、boundedなprocess-local lifecycle counter、phase別error count、optionalなstatic runtime identity、最後に観測したevent timestampだけです。principal ID、operation ID、reservation ID、tool名、budget key、raw error、tool argumentは含みません。

このcounterは **non-authoritative telemetry** です。event replayで同じlifecycle eventが再度観測されることがあり、process再起動ではprocess-local counterがリセットされます。snapshotからquota balance、billing total、replay decisionを導出しないでください。

operational subpathから `MCP_USAGE_CONTROL_VERSION` をexportし、core package manifestのversionと同期させます。`createUsageRuntimeIdentity()` にはstaticなprovider mode、bounded capability flag、optionalなstorage schema versionも指定できます。provider側でstableな意味をdocumentできるschema versionだけを出し、意味が不安定なら省略してください。

### Retentionとquota stateを分離する

`MemoryUsageStore.stats()` はretained bookkeeping resourceを示します。これは「active billable operation数」でもauthoritative remaining quotaでもありません。retention/resource health、lifecycle telemetry、scoped accounting balanceは分離して扱います。

複数budgetや異種vector dimensionをまたいだ1つのglobal `consumedUnits` は出さないでください。同じreservationが複数budgetへ参加でき、異なるdimensionを1つのsynthetic totalへ潰すと意味が壊れます。

## 明示scopeしたquota projection

authoritative `remaining` は、applicationが所有する正しいbudget/windowを明示選択した場合だけ意味を持ちます。選択済みbalanceを次のようにprojectします。

```ts
import { projectScopedQuota } from 'mcp-usage-control/operational';

const admission = await control.reserve(request);
if (admission.allowed) {
  const daily = admission.remainingByBudget.find(item => item.key === dailyBudget.key);
  if (daily) {
    const quota = projectScopedQuota(dailyBudget.limit, daily.remaining);
    // { limit, remaining, used, exhausted, utilization }
  }
}
```

helper自身はbudget keyを受け取りません。window名、reset rule、authoritative balanceの選択はapplication-ownedのままです。

## Canonical settlement outcome

domain固有のoutcomeはusage boundaryへ渡す前にnormalizeします。

```ts
import {
  InvalidSettlementOutcomeError,
  normalizeSettlementOutcome,
} from 'mcp-usage-control/settlement-outcomes';

const outcome = normalizeSettlementOutcome('invalid_browser_request', {
  invalid_browser_request: 'invalid_arguments',
});

await lease.settle(0, outcome);
```

canonical vocabularyは以下です。

- `authorization_denied`
- `invalid_arguments`
- `pre_dispatch_rejected`
- `pre_dispatch_no_effect`
- `cancelled_before_dispatch`
- `completed`
- `proven_no_effect`
- `dispatched_conservative`
- `cancelled_after_dispatch`

default alias mapでは、既存integration向けに `success`、`tool_error`、`error` などのbounded compatibilityを維持します。

不正なvocabularyは `InvalidSettlementOutcomeError` をthrowし、bounded codeは `invalid_settlement_outcome` です。不正なraw value自体はerrorへ保持しません。これにより、fail-closed settlementを弱めずに、local integration/configuration bugとStore/backend unavailableを区別できます。

settlement normalizationはrefund可否を決めません。provider evidenceからcanonical outcomeとactual unitsへmapする責任はapplication側にあります。dispatch後のambiguous failureを、provider errorが返ったという理由だけで `proven_no_effect` にしないでください。

## Threshold / exhaustion signal

threshold helperは明示scope済みquota snapshotだけを対象にします。

```ts
import { projectScopedQuota } from 'mcp-usage-control/operational';
import {
  didUsageQuotaThresholdCross,
  evaluateUsageQuotaThreshold,
} from 'mcp-usage-control/thresholds';

const previous = projectScopedQuota(100, 25);
const current = projectScopedQuota(100, 20);
const threshold = { kind: 'remaining_ratio', value: 0.2 } as const;

if (didUsageQuotaThresholdCross(previous, current, threshold)) {
  await applicationOwnedAlertSink('quota-low');
}

const state = evaluateUsageQuotaThreshold(current, threshold);
```

対応するthreshold形式:

- `{ kind: 'remaining_units', value: N }`
- `{ kind: 'remaining_ratio', value: 0..1 }`

`didUsageQuotaThresholdCross()` は above -> reached へ移った時だけ `true` を返します。同じauthoritative balanceのretry/replayでは再度crossしません。callerは対象accounting windowのprevious stateを保持し、application-owned windowが切り替わった時にそのstateをresetします。configured limitが変わった場合は、同じwindowだと推測せずcrossing helperがrejectします。

exhaustion crossingには `{ kind: 'remaining_units', value: 0 }` を使います。

Slack、email、webhook、queue、dedupe persistence、notification retry policyはcore外です。alert sinkの失敗でadmissionやsettlementを変更してはいけません。

## Safety summary

- Store/accounting stateだけがenforcement authority。
- operational counterはprocess-local / bounded / non-authoritative。
- scoped remainingはapplication-owned budget/windowを明示選択して使う。
- settlement vocabulary errorはbad raw valueを露出せずservice failureと区別可能。
- threshold helperはpureで、accounting-window stateとalert deliveryはapplication-owned。
- entitlement、pricing、subscription lifecycle、reset windowをhelper側で推測しない。
