# MCP利用量制御の障害・ACK不明時の運用判断ガイド

[English](operation-recovery-playbook.md)

新しい自動復旧APIではなく、**どの証拠を元に次の操作を判断するか**をまとめたガイドです。状態の定義は[読み取り専用の操作再照合](operation-reconciliation.ja.md)、永続化ドメインの保全・復旧は[インシデント対応](incident-response.ja.md)、MCP処理の境界は[MCP連携](mcp-integration.ja.md)を参照してください。監視カウンター、MCP request ID、HTTP status、ログだけで再実行・返金を認可してはいけません。

## 再試行より先に証拠を確認

1. 会計または実行権限が不明なら、該当ドメインの**新しい有料処理を停止・制限**します。Store障害時に無制限利用へフォールバックしません。
2. 失敗したフェーズ、**信頼できるサーバー側**のtenant・principal・tool・論理操作ID、元のbudget key/dimension/予約単位、Store種別・schema/runtime version、ACK/エラー、時計の基準を記録します。個人識別子はアクセス制御されたインシデント記録に限定し、**公開ログやmetric labelに生のIDを出しません**。
3. **明確な拒否・処理未開始**、**ACK不明**、**Storeの読み取り専用再照合**を区別します。timeoutやthrowだけではStore rollbackやコストゼロを証明できません。
4. 対応Store/操作モードでのみread-only reconcileを行います。接続障害、binding不一致、保持期限後、非対応は**indeterminate（不確定）/ fail-closed**とし、`duplicate_operation`を回避するために別のIDを作りません。
5. プロバイダの課金証拠・業務結果・worker fencing・必要な補償判断はアプリケーション所有者にエスカレーションします。本ライブラリは請求・返金台帳ではありません。

## フェーズ別判断表

| フェーズ・観測 | 確認事項と安全な対応 | 禁止する近道 |
| --- | --- | --- |
| policy quoteが明確に拒否 | 新規予約も有料handler実行もなし。正しい認証・policy入力を確認した上で、新しい意図的な操作として扱います。 | 拒否回避のため既存操作IDを差し替える。 |
| `quota_exceeded` または `duplicate_operation` | その呼出はhandlerに入らない。すべてのbudgetを確認し、過去結果が必要なら**業務側**の結果/冪等性Storeから回復します。 | 二重操作拒否を過去結果の再配信・成功と解釈する。 |
| 初回`reserve()`の転送エラー / ACK喪失 | 予約済みの可能性あり。有料dispatchを止め、対応Storeで信頼できるscalar/vectorの完全な元quote identityを使いread-only再照合します。 | 無条件に再予約、新ID発行、`absent`だけで再実行。 |
| handler入場**前**の`markLiable()` ACK不明 | wrapper上のhandlerは未実行でも、コスト責任の記録はcommit済みかもしれない。lease identityを保持し、権威ある証拠とアプリ管理の復旧を要求します。 | pendingと断定、ゼロ返金、lease未証明のまま処理開始。 |
| progressive/vector `grow()` ACK喪失 | 増枠がcommit済みの可能性。growth cursorと予約IDを維持し、そのproviderが保証するexact-replay/再照合範囲だけを利用。不明ならfail-closed。 | 適当な増枠額で再実行、増枠失敗と推測して有料処理続行。 |
| 自動`renew()` ACK喪失 | `onLeaseRenewalState: uncertain`は**助言的通知**。実際には更新されている可能性もある。アプリ/プロバイダ側で新規有料露出を停止するか、fencingするか判断。後の`confirmed`も上流worker所有権を普遍的には証明しない。 | callbackをStoreの正本時計や再実行許可にする。 |
| `isError: true` / handler例外 / liability後の中断 | クライアント側のエラーはコストゼロを示さない。**実際のコストを証明できない場合は最大予約額を保守的に計上/保持**します。 | エラーだから自動`settle(0)`、timeoutだから返金。 |
| `settle()` ACK喪失 / `UsageSettlementError` | 精算commit済みかもしれない。業務結果と会計の不明状態を分けて保存、対応するread-only statusを調査し、不確定ならエスカレーション。 | 別outcomeで再精算、handler再実行、新しい操作の予約。 |
| MCP `input_required`中断/一回限りのflow claim ACK喪失 | requestStateの検証とサーバー側atomic compare-and-consumeが必要。ACK不明ならtokenは消費済みの可能性がある。fail-closedで業務結果は別途回復。 | 生のclient tokenで再入場、requestState検証の無効化。 |
| Store停止、破損、binding不一致、再照合非対応 | indeterminate。コスト発生dispatchを止め、互換Storeへの接続を復旧。永続化破損ならインシデント手順へ。 | 無制限許可、予約削除、会計ドメイン再初期化、schema marker書換。 |

**エラーの見え方:** 公式MCPクライアントには、サーバー内部で`UsageDeniedError`、`UsageClassificationError`、`UsageSettlementError`がthrowされても、サニタイズされた`isError`結果として届く場合があります。MCPのエラー表示だけではStoreのcommit/rollbackや上流費用は判断できません。内部例外・policy・tenant ID・budget key・秘密情報をクライアントへ漏らしません。

## Providerごとの読み取り専用再照合の範囲

| Store | scalar初回予約 | vector初回予約 | 制約 |
| --- | --- | --- | --- |
| Memory | 対応 | 対応 | プロセス再起動で状態消失。再起動後の`absent`は過去の実行なしを証明しない。 |
| Redis | 対応 | 対応 | Redis `TIME`とread-only Lua。共有atomicドメインは同一Cluster hash slotに収める。永続化/HAはデプロイ固有。 |
| Firestore | 対応 | 対応 | read-only transaction。期限判定にhost clockの同期・偏差制限が必要。共有budgetで競合が起こり得る。 |
| Cloudflare Durable Objects | 認証付きremote scalar lookupで対応 | **非対応・fail-closed** | 1つのDurable ObjectがSQLite atomicドメイン。scalar helperからvector対応やプラットフォーム障害耐性を推測しない。 |

権威あるread-only statusには`active/pending`、`active/liable`、`expired/pending`、`expired/liable`、`settled`があります。しかし**これだけで業務処理の再実行が許可されるわけではありません**。`active/pending`から復帰する場合も「処理が開始されていない」という別のアプリ側証明と、正しい元leaseへの再接続が必要です。liable・expired liableは再実行/返金を許可しません。`settled`は会計の終端、`absent`は現在の保持状態がないという意味だけで、保持期限後やMemory再起動後は特に危険です。Store読み取り失敗や非対応はindeterminateです。[操作再照合](operation-reconciliation.ja.md)に正規の引数・契約があります。

## シナリオA: 初回予約のACKを喪失

- 認証済みtenant/principal、`tool=report`、論理操作ID `report-001`、最大5単位、budget `tenant-A:2026-10`でreportの予約を要求しました。
- タイムアウトしても、**有料reportを開始せず**、別IDにして予約し直しません。Storeの疎通確認後、対応するscalar read-only再照合を**同じ元ID・budget topology・予約単位**で行います。
- `active/pending`なら「別workerがすでに有料処理を開始していない」というアプリ側の追加証明を確認し、元leaseへの安全な再接続を判断します。`active/liable`・`expired/liable`・`settled`では再実行を禁止します。保持期限後の`absent`やエラー・binding不一致なら不確定として処理停止を継続します。
- Cloudflareの**vector**初回予約では同等のremote read-only再照合が提供されていません。scalar helperで代用せず、証拠を保存してエスカレーションします。

## シナリオB: handler完了後に精算ACKを喪失

- 最大5単位を予約し、`markLiable()`後にreportが完了しました。実測の使用量3単位で`settle(3, 'success')`しましたが、ACKを受け取れませんでした。
- 業務結果はアプリケーション所有の結果/冪等性Storeに保持し、**会計の精算状態は不確定**として分けて扱います。SDKが`isError`を返しても実際のプロバイダ費用は取り消されません。
- 同じ信頼済みの操作IDで可能なread-only再照合を行います。保持された`settled`は終端、`active/liable`なら費用責任が残り、プロバイダ固有の復旧判断が必要です。障害・binding不一致は不確定で、**reportを再実行したりゼロ精算しません**。
- 顧客補償は監視カウンターから自動判断せず、業務側の監査可能な請求/プロバイダ証拠で決定します。

## 関連資料

- [実行可能なMCPサーバー + クライアント](../examples/mcp-protect-tool/README.ja.md) — 正常・拒否・使用量不明のローカル検証。本番認証は含みません。
- [MCP論理操作ID](mcp-operation-identity.ja.md) — 転送IDから弱い重複排除を作らない。
- [運用監視](operational-usability.ja.md) — `UsageOperationalMonitor`等はbest-effortで、会計残高の正本ではありません。
- [インシデント対応](incident-response.ja.md) — 互換性を確認せずに永続化データやaccounting domainを変更しない。
