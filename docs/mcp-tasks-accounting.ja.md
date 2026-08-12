# MCP Tasks の利用量 accounting

[English](mcp-tasks-accounting.md) | [日本語](mcp-tasks-accounting.ja.md)

この文書では、`UsageStore` をタスクスケジューラや汎用ワークフローエンジンにせず、長時間動く MCP Tasks をどう利用量 accounting に結びつけるかを定義します。

利用量側で使うライフサイクルは既存のままです。

```text
quote -> atomic reserve -> pending -> cost-liable -> renew -> settle
```

MCP Task の状態と、利用量 accounting の状態は関係しますが、**同じ状態機械ではありません**。

## プロトコル基準と対応範囲

2026-08-13 時点で、このリポジトリは MCP `2026-07-28` 系を対象にし、TypeScript の client/server SDK `2.0.0` をテストしています。

現在の MCP Tasks は `io.modelcontextprotocol/tasks` extension として設計されています。draft では task 対応 `tools/call`、`tasks/get`、`tasks/update`、`tasks/cancel` と、`working`、`input_required`、`completed`、`failed`、`cancelled` の状態が定義されています。

一方、TypeScript SDK v2 の core は旧来の `tasks/*` wire vocabulary を modern core protocol として扱いません。Tasks extension の仕様・実装は別リポジトリで管理され、現時点では明示的に experimental です。そのため本プロジェクトは **accounting semantics を先に確定・検証**し、安定版の first-class TypeScript Tasks adapter まではまだ名乗りません。

判断に使った一次情報:

- MCP `2026-07-28` release notes: <https://blog.modelcontextprotocol.io/posts/2026-07-28/>
- TypeScript SDK `2026-07-28` support notes: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md>
- Tasks extension repository/specification: <https://github.com/modelcontextprotocol/ext-tasks>

これは互換性上の境界であって、accounting core の不足ではありません。既存の lease primitive で以下の安全性を表現できます。

## 2つの状態機械と1つの論理 operation

MCP 側の task status は遅延実行の状態を表します。

```text
working <-> input_required -> completed | failed | cancelled
```

利用量側は従来どおりです。

```text
absent
  |
  | atomic admission
  v
pending
  |
  | metered/business execution がコストを発生させ得る直前
  v
cost-liable
  |
  | authoritative execution が継続する間 renew
  v
settled
```

Task status が変わっただけで、accounting state を自動的に変えてはいけません。特に次を区別します。

- `working` は「コスト発生済み」の証明ではない
- `input_required` で新しい利用量 operation を作らない
- `tasks/cancel` の成功 ACK は、処理停止やコスト 0 の証明ではない
- task TTL の期限切れや task 削除は、予約を返金してよい証明ではない
- `isError: true` の tool result を持つ Task は MCP 上は `completed` でも、accounting では実際の metered outcome を保守的に扱う

## 状態遷移 contract

| イベント | 必要な accounting 動作 | 失敗時の原則 |
| --- | --- | --- |
| 最初の task-backed `tools/call` admission | 安定した論理 `operationId` に対して quote + atomic reserve を **1回だけ**行う。task ID は2個目の operation ID ではない。 | reserve ACK が曖昧なら同じ論理 operation のまま reconciliation/replay する。別予約を作らない。 |
| Task を durable に作成し handle を返す | 自動では cost-liable にしない。実際の metered boundary を越える前なら `pending` のままでよい。 | task 作成/response ACK の喪失で business operation を blind replay しない。task 作成側に別の idempotency/reconciliation が必要。 |
| Worker が metered execution に入る直前 | コストが発生し得る処理より **前**に `markLiable()`。 | `markLiable()` が失敗、または ACK が曖昧なら metered work を開始しない。fail closed。commit 済み ACK 喪失なら後の liable expiry で保守的に課金され得る。 |
| Task が `working` のまま | authoritative task controller が operation を active と見なす間、同じ lease を renew。 | renew 失敗後に新しい予約を取って blind continue/replay しない。 |
| Task が `input_required` | 同じ reservation/lease を保持し、意図して task を維持する間は server-side で renew。`tasks/update` は quote/reserve せず同じ論理 operation を再開。 | client polling や入力送信自体を lease authority にしない。入力の重複や ACK 問題は task/business state 側で処理する。 |
| Task `completed` | 証明できる actual units があれば1回 settle。 | 実行開始後の actual usage が不明なら reserved amount まで保守的に settle。protocol status だけで返金しない。 |
| Task `failed` | pre-cost failure を証明できるなら 0 settlement 可。liable なら既知 actual usage、分からなければ原則 full reservation。 | JSON-RPC/task error は provider cost 0 の証拠ではない。 |
| `tasks/cancel` request の ACK | **ACK だけでは settle/refund しない。** cancellation は cooperative / eventually consistent で、通常完了する可能性もある。 | authoritative terminal execution state を待つか lease expiry に任せる。 |
| liability 前に authoritative `cancelled` | 明示的な pre-execution cancellation outcome で 0 settle。 | metered boundary 未通過を server が証明できる場合だけ安全。 |
| liability 後に authoritative `cancelled` | 証明できる actual usage、分からなければ full reservation を保守的に保持。 | `cancelled` から usage 0 を推測しない。 |
| Client が polling を止める / disconnect | それだけでは accounting transition なし。 | lease renew と terminal settlement は server-side task controller の責任。client liveness を refund 条件にしない。 |
| Worker/process が liability 前に crash | renew を止める。既存 store contract により pending expiry が capacity を解放。 | accounting recovery のためだけに新規予約を作らない。 |
| Worker/process が liability 後に crash | 安全に継続できる authoritative worker がいなければ renew を止め、liable expiry で full reservation を保持。 | business operation を blind replay しない。代替 worker の再開可否は別の business-side claim/idempotency で決める。 |
| settlement ACK 喪失 | store が contract 上の idempotent tombstone を持つ場合だけ **同一 settlement** を replay。 | conflicting settlement は fail closed。可用性回復のため別 settlement を投げない。 |
| reconciliation で external/provider の最終結果が判明 | 同期時と同じ terminal settlement を適用。 | reconciliation を2つ目の admission path にしない。既に conflict する settlement を書き換えない。 |

## 1 logical operation = 1 reservation

Accounting identity は引き続き次です。

```text
(tenantId, principal.id, tool, operationId)
```

Task ID は protocol/business task state の識別子です。`operationId` の代わりにも、usage authorization にも、新しい accounting scope にもなりません。

期待する流れはこうです。

```text
tools/call
  -> reserve(logical operation) once
  -> durable business task created
  -> metered work 前に markLiable()
  -> active / input wait の間 renew()
  -> authoritative terminal accounting state で settle() once

tasks/get      -> task state を読むだけ
tasks/update   -> 同じ operation を継続。reserve しない
tasks/cancel   -> cancellation intent。ACK だけでは refund しない
```

最初の response が曖昧で original request を retry する場合も同じ logical operation identity を使います。duplicate-operation protection は2個目の reservation を防げますが、任意の business task creation を安全に replay できる保証ではありません。task system 側で task creation/result を独立に deduplicate / reconcile する必要があります。

## Cost-liable にする境界

汎用 wrapper の安全な境界は同期 tool と同じです。metered cost が発生し得る application/provider execution の直前に `markLiable()` します。

Task 自体はその前に作って構いません。たとえば durable queue に積んだだけで高コスト処理がまだ始まっていないなら reservation は `pending` のままにできます。逆に task 作成前の setup ですでに metered work がある設計なら、その work より前に liable にする必要があります。

MCP status string から liability を推測してはいけません。`working` は operationally active という意味で、provider billable boundary 通過済みの証明ではありません。

## Lease renewal と Task TTL は別物

時間に関する概念は3つを分離します。

1. **usage lease TTL** — authoritative renewal がない active reservation をいつまで維持するか
2. **MCP task TTL** — task protocol record をいつまで保持・利用可能とするか
3. **settled idempotency tombstone TTL** — settlement 後の duplicate operation / identical settlement replay protection をいつまで残すか

どれかを別のものの代用にしてはいけません。

Renewal は `tasks/get` polling ではなく、authoritative execution を所有する server-side component が行います。静かな client のせいで正常な長時間 task の lease が切れてはいけませんし、逆に polling が多いだけで死んだ worker の reservation が無期限延命されてもいけません。

`input_required` で task を意図的に保持する場合は同じ lease を renew できます。ただし abandoned input wait が永続的に quota を予約しないよう、product policy で待機期間を上限設定するのが望ましいです。

## Cancellation semantics

Tasks extension の cancellation は cooperative かつ eventually consistent です。したがって `tasks/cancel` の成功 ACK は「cancel intent を受理した」という意味でしかなく、terminal `cancelled` や work 0 の証明ではありません。

Accounting は次のように保守的に扱います。

```text
cancel ACK
  -> settlement しない
  -> authoritative execution outcome
       |- pre-cost cancelled を証明 -> settle 0
       |- liable + usage 判明       -> known usage で settle
       `- liable + usage 不明       -> full reservation / conservative expiry
```

これで cancellation race が refund 手段になるのを防ぎます。

## Crash、abandonment、安全な再開

Usage store が持つのは quota reservation、liability、renewal、settlement、expiry recovery です。worker assignment、task queue、result storage、exactly-once business execution は持ちません。

Worker crash 後は次のように分離します。

- 同じ business operation の継続が安全だと deployment 側で証明できる場合、trusted server-side `UsageLeaseResumeState` から accounting state を reattach できる
- accounting state を reattach できること自体は、business work の replay 許可ではない
- task scheduler は独自の fencing token、job claim、provider idempotency key、result reconciliation などで別 worker が進めるか決める
- 安全な継続を証明できなければ renew を止め、既存の pending/liability expiry semantics で保守的に解決する

この分離は意図的です。task queue/result state を `UsageStore` に入れると汎用 workflow engine 化し、quota enforcement を強化しないまま correctness surface だけが広がります。

## 曖昧な ACK

既存の failure-safe rule をそのまま適用します。

- reserve ACK ambiguity: stable logical identity を維持して reconcile。無関係な2個目の reserve はしない
- liability ACK ambiguity: safe transition を確認できないまま metered work に入らない。store commit 済み ACK 喪失なら conservative expiry を許容
- renew ACK ambiguity: lease extension 成功を確認できないなら成功前提で進めない
- settlement ACK ambiguity: identical settlement replay は idempotent にできる。conflicting settlement は fail
- task/business ACK ambiguity: task/business layer で解決し、accounting state を理由に副作用を blind replay しない

## Horizontal scale

MCP transport request が別 server instance に着地しても構いません。ただし production の usage accounting は authoritative shared state を必要とします。

v1 方針は現行方式を維持します。

- reservation/liability/renewal/settlement 用の shared/durable `UsageStore`
- MRTR を使う場合は one-time compare-and-consume を持つ shared/durable `McpUsageFlowStore`
- Tasks を実装する場合は、それらとは別に durable task state と business execution ownership を管理する task backend

Accounting のための sticky MCP session は不要です。task router が task ID などの protocol routing hint を使うことはありますが、それは task placement の問題であり、shared accounting contract を弱める理由にはなりません。

## 実装状況

**Accounting contract: 定義済み・core proof test あり。**

`packages/core/src/task-accounting-proof.test.ts` で、長時間/input wait 中の renewal、liability 前 cancellation、liability 後 cancellation、pending/liable worker crash expiry、terminal settlement の idempotent/conflicting replay を既存 primitive に対して検証します。

**First-class MCP Tasks adapter: deferred / experimental。**

現在の accounting lifecycle を表現するための新しい runtime API は不要です。MCP Tasks extension と TypeScript 実装 surface が十分安定してから、experimental wire/runtime contract へ package を固定せずに統合できる形で adapter を追加します。

本プロジェクトが first-class Tasks protocol support を宣伝しない限り、これは v1 の accounting blocker ではありません。upstream extension が v1 判定前に安定化しない場合、post-v1 integration candidate とします。
