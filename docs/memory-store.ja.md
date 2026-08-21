# Memory storeの長期運用

`MemoryUsageStore` は、テスト・開発・制御されたsingle-process deployment向けのprocess-local reference implementationです。プロセス終了をまたぐdurabilityはなく、restart後もaccounting stateを維持する必要がある場合や複数instanceで同じbudgetを共有する場合は、Redis / Cloudflare Durable Objects / Firestoreの代替にはなりません。

## 長時間稼働時に保持するstate

storeは主に次をメモリ上に保持します。

- active reservation
- replay protection用のsettled operation tombstone
- budget keyごとのnon-zero usage total

active reservationはlease expiry時にrecoveryされます。settled operation tombstoneは`idempotencyTtlMs`（default 24時間）の間保持した後に削除します。expiry scanは毎回全件走査せず、既知のreservation / tombstoneの最短deadline付近で実行するようにしています。

一方、non-zeroのbudget usageは勝手に消せません。使用済みbudget keyをLRUや単純TTLで削除するとquotaが暗黙にresetされるため、`MemoryUsageStore`はauthoritative usage stateを推測でevictしません。

## bounded retentionとfail-closed capacity

無制限なメモリ増加を防ぐため、`MemoryUsageStore`にはdefault retention capがあります。

- `maxRetainedOperations`: active reservation + settled replay tombstoneを最大100,000件
- `maxRetainedBudgetKeys`: non-zero usageを保持するdistinct budget keyを最大100,000件

どちらも`MemoryUsageStoreOptions`で変更できます。

capを超える新しいstateが必要になった場合は`MemoryUsageStoreCapacityError`をthrowします。既存accounting stateを捨てて空きを作ることはしません。これは意図的なfail-closed動作で、memory pressureがquota resetやreplay protection喪失につながらないようにするためです。

```ts
const store = new MemoryUsageStore({
  idempotencyTtlMs: 60 * 60 * 1000,
  maxRetainedOperations: 50_000,
  maxRetainedBudgetKeys: 20_000,
});
```

`maxRetainedOperations`は、想定logical-operation rate × replay protectionの保持時間を基準にし、active work分のheadroomを含めて設定してください。これはper-principal usage quotaではなくoperational retention capなので、`Budget.limit` を基準にサイズしません。`idempotencyTtlMs`を短くするのは、application側のretry / replay horizonがそれより短いと保証できる場合だけにします。

`stats()`で現在のretained operation数・budget key数と設定上限を取得できるため、health checkや運用監視に使えます。これらはusage totalではなくretention pressureのcounterです。`retainedOperations` にはactive reservationとsettled replay tombstoneが含まれ、最終的に0 unitsでsettleするoperationも保持中は数えられます。

## time-window budget keyのretire

windowをbudget keyへ含めるpolicyでは、例えば次のようなkeyになります。

```text
day:user:42:2026-08-13
day:user:42:2026-08-14
month:tenant:7:2026-08
```

generic store側では、どの時点で古いkeyがpolicyのaccounting horizonから完全に外れたかを安全に推測できません。制御されたsingle-process deploymentでは、完了済みwindowをapplicationが明示的にretireできます。

```ts
store.retireBudgetKey('day:user:42:2026-08-13');
```

`retireBudgetKey()`はactive reservationが参照しているbudget keyの削除を拒否します。またcaller側は、そのkeyが同じaccounting windowとして再利用されないことも保証する必要があります。liveまたは再利用可能なbudgetをretireするとin-memory usageを意図的にresetすることになるため、これは自動GCではなくapplication-level lifecycle decisionです。

unitsが0のreservationはbudget keyをretained usage mapへ追加しません。

## Operation reconciliation (v0.8)

`MemoryUsageStore` はoptional `OperationReconciliationStore` を実装します。`reconcileOperation()` はexpiry recoveryを実行せず、quota stateを書き換えずにretained scalar operation stateをreadします。expected logical operation identity、reserved units、budget keyを検証し、共通の `absent` / `active` / `expired` / `settled` 語彙を返します。

Memory stateはprocess-localなので、restart後の`absent`を「operationが過去に存在しなかった」historical proofとして扱えません。scalar reconciliationはretained vector reservationをrejectします。

## production guidance

次のどれかに当てはまる場合はshared / durable storeを使用してください。

- process restart後もaccounting stateを保持する必要がある
- 複数application instanceが同じbudgetをenforceする
- historical budget keyが大量またはunboundedに増える
- application-managed budget retirementなしで長期capacityを維持する必要がある
- process-local reference storeを超えるpersistence / HAが必要

retention capはdurability機能ではなく安全用guardrailです。cap到達は、semanticに安全なcompleted windowのretire、保持設定の見直し、またはproduction storeへの移行が必要なoperational signalとして扱ってください。
