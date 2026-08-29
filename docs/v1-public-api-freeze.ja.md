# v1 public API / lifecycle freeze

このdocumentは、v1 public surfaceを定義するv0.11時点のdecisionを記録します。v1 promotionではbug fixやdocumentation改善はできますが、新しいcompatibility decisionなしにここでfreezeしたconceptをrenameしたりincompatibleにtightenしたりしません。

## Package名

public package名は次の5つでfreezeします。

- `mcp-usage-control` — core accounting control、Memory Store、shared contract
- `mcp-usage-control-mcp` — MCP server tool-handler integration
- `mcp-usage-control-redis` — Redis Store
- `mcp-usage-control-cloudflare` — Cloudflare Durable Objects Store
- `mcp-usage-control-firestore` — Firestore Store

v1での`@scope`化、gateway指向rename、billing指向rename、provider package統合は行いません。

core packageの既存public subpathも維持します。

- `mcp-usage-control/operational`
- `mcp-usage-control/settlement-outcomes`
- `mcp-usage-control/thresholds`
- `mcp-usage-control/conformance`

repository内に存在するだけのprovider-internal file / undocumented source pathはpublic subpathではありません。

## Accounting lifecycle terminology

stable lifecycle vocabularyは次です。

```text
quote -> reserve -> mark liable -> [grow] -> [renew] -> settle
```

persisted reservation stateは次を維持します。

- `pending` — capacityはreserve済みだがmetered executionはliability boundaryを越えていない
- `liable` — metered executionでusageが発生した可能性があり、unknown expiryはconservativeに扱う
- `settled` — authoritative reservationがterminal accounting resultへ到達した

`grow`は同じlogical reservationのreserved capacityを増やします。`renew`はlease timeだけを延長します。どちらもretry / re-admission / billing / reconciliationとは別conceptです。

logical operation identityはStoreが対応する範囲で `(tenantId, principal.id, tool, operationId)` にscopeします。resumeは同じsuspended usage flowに2本目のreservationを作りません。

## Settlement outcome typing decision

### Store / direct lease boundary: intentional extensible `string`

`SettleInput.outcome`、`SettlementResult.outcome`、`VectorSettleInput.outcome`、`VectorSettlementResult.outcome`、`UsageLease.settle(..., outcome)`、`VectorUsageLease.settle(..., outcome)` はv1でも `string` を維持します。

これはtyping未完了ではなく意図したextension pointです。Store contractはlow-level idempotent accounting boundaryであり、既存applicationはdomain-specific outcome labelをpersistしている可能性があります。closed unionへtightenするとreserve / liability / settlement safetyを強めない一方でsource / persisted replay compatibility pressureを作ります。

settlement replay equalityはexactのままです。custom outcomeを使うapplicationはidentical replayで同じstable valueを使う責任があります。

### Bounded integration vocabulary: canonical outcome

portable diagnosticやlibrary-owned lifecycle classificationが必要なintegrationでは、`mcp-usage-control/settlement-outcomes`を使いsettlement前にnormalizeします。

canonical vocabularyは次です。

- `authorization_denied`
- `invalid_arguments`
- `pre_dispatch_rejected`
- `pre_dispatch_no_effect`
- `cancelled_before_dispatch`
- `completed`
- `proven_no_effect`
- `dispatched_conservative`
- `cancelled_after_dispatch`

`normalizeSettlementOutcome()` はapplication/integration aliasとbounded vocabularyの明示境界です。unknown valueは`InvalidSettlementOutcomeError`でfailし、diagnosticはraw unknown inputを保持しません。

built-in MCP adapterはStore settlement前にこのnormalizationを実行します。そのためcompatibility aliasをsupportしながら、MCP-specific vocabularyをpersisted outcomeへ流しません。例えば `success` / `tool_error` は `completed`、`error` やconservativeな `input_required` failure aliasは `dispatched_conservative` へnormalizeします。

direct core callerは暗黙normalizeされません。canonical vocabularyを使いたい場合は`settle()`前にnormalizerを明示的に呼びます。

## Scalar / vector parity

scalar / vector accountingは同じlifecycle conceptを持ちます。

- use前のreserve
- metered work前のexplicit liability
- optional bounded growth
- capacityを変えないlease renewal
- successfully reserved capacity以内のsettlement
- pending / liable expiryの区別
- stable operation replay protection
- extensible Store outcome string + 同じoptional canonical normalization boundary

vector APIではdimensionをexplicitに維持します。異種unitを1 synthetic totalにまとめるv1 scalarization helperは追加しません。

## Public status / reason vocabulary

operation reconciliation statusは次でfreezeします。

- `absent`
- `active`
- `expired`
- `settled`

`active` / `expired` は該当時reservation state `pending | liable` を伴います。`absent`はretained-state observationであり、historical operationが存在しなかった証明ではありません。

built-in Store contractが所有するadmission denial reasonは次です。

- `quota_exceeded`
- `duplicate_operation`

progressive/vector growthのdefinitive capacity denialは`quota_exceeded`です。provider ambiguityは別denial reasonへ変換せずexception / fail-closed conditionとして扱います。

recovery vocabularyは次です。

- `pending_released`
- `liable_retained`

これらはauthoritative recovery behaviorでありbilling/payment statusではありません。

## Error vocabulary

core public errorのroleは維持します。

- `UsageDeniedError` — wrapperがsurfaceするpolicy/admission denial
- `UsageStateError` — authoritative state mismatch、invalid lifecycle transition、unsupported/corrupt Store stateなどのfail-closed state rejection
- `MemoryUsageStoreCapacityError` — bounded Memory Store retention capacity
- `InvalidSettlementOutcomeError` — bounded canonical-outcome normalization failure

MCP adapter public errorのroleも維持します。

- `UsageSettlementError` — settlement failureでstateがambiguousな可能性
- `UsageClassificationError` — cost classification failure後にconservative settlementをattempt
- `UnsupportedMcpUsageFlowError` — single-round wrapperが`input_required`に遭遇
- `McpUsageResumeError` — resume state missing / invalid / expired / replayed / binding mismatch
- `McpUsageRoundsExceededError` — configured multi-round limit超過

provider SDK/network error名をstable cross-provider public enumへ昇格しません。provider-specific authoritative reconciliation ruleがないambiguous provider failureは引き続きpropagate / fail closedします。

## MCP multi-round scope

public multi-round terminologyは `protectMultiRoundTool()`、`McpUsageFlowStore`、`McpUsageFlowRecord`、`McpUsageFlowBinding`、`McpUsageFlowContext`、request-state mint/verify integrationを維持します。

v1で別のpublic `MRTR` accounting state machineは追加しません。MCP suspended-flow storageはresume integrityとone-time flow consumptionを制御し、underlying usage reservationがaccounting authorityのままです。

business task/result persistence、payment state、provider result replay、application workflow stateはこのpackageのusage-accounting authority外です。

## Freeze後のnaming / compatibility rule

v1では:

- additive helperはfrozen accounting lifecycleを再定義しない場合だけ検討
- renameはpublic nameを黙って置換せずdocumented compatibility alias / deprecation pathを使う
- persisted provider stateは別documentの [persisted-state compatibility contract](persisted-state-compatibility.ja.md) に従う
- provider implementationはprovider-specific diagnosticを追加できるが、cross-provider core vocabularyはproviderが証明できないsemanticをclaimしない
- npm publicationはseparate explicit authorizationのままで、このAPI decisionを変更しない
