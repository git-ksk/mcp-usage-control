# Progressive reservation growth / 段階的予約拡張

状態: **v0.6 設計contract。portable/provider proof完了までは採用未確定。**

この文書は、second logical operationを作らず、1つのlive reservationのcapacityをfailure-safeに増やす候補contractを定義する。

## 境界

Progressive growthは既存reservation lifecycleの拡張とする。

`quote -> reserve -> [grow]* -> mark liable -> [grow/renew]* -> settle`

`grow`が変更するのはreserved capacityだけ。lease更新、business-result replay、wallet、別logical operationの生成は行わない。

既存のfixed reservation modelは引き続き有効。third-party `UsageStore`にgrowth実装を必須化しない。

## Public shape

候補public surfaceは次のとおり。

- application-facing helper: `UsageLease.grow(...)`
- optional Store capability: `ProgressiveUsageStore` + `growReservation(...)`
- growth-capable Storeが作るreservationへのadditive growth metadata

`renew`はlease duration専用のままにし、capacity取得を混ぜない。

growth attemptは以下を持つ。

- 既存`reservationId`
- 1つのlogical increase attemptを一意に表すapplication-stableな`incrementId`
- leaseに付与されているStore-issued `growthCursor`
- `additionalUnits`
- current limitを含むparticipating budgets一式

budget key setは初回reservationと完全一致させる。growthでbudget追加・削除・置換はできない。

## Growth cursorとlost ACK

`growthCursor`はopaqueなreplay fenceであり、authorization credentialではない。

Storeは**authoritativeに完了したattempt**ごとにcursorをrotateする。

- capacity increase accepted
- authoritative quota denial

provider/transport failureでauthoritative resultを証明できない場合はsuccessへ変換しない。

lost-ACK時は次の動作になる。

1. callerがincrement `I`をcursor `C0`で送信
2. Storeがresultとexact replay metadataをatomic commitし、cursor `C1`を生成
3. ACK喪失
4. caller側は`C0`のまま
5. 同じparameters + `C0`で`I`をretryするとrecorded resultと`C1`をreplay
6. stale `C0`で別incrementを送るとfail closed

したがってambiguous result後は同じ`incrementId`を保存/再構成できなければならない。fresh identityを発行して再試行してはいけない。

## Replay semantics

active reservation/tombstoneに保持された直近completed attemptについて:

- same `incrementId` + same prior cursor + same canonical parameters -> exact replay、capacity追加なし
- same `incrementId`でもunits/limits/budget set/cursorが異なる -> state conflict
- different `incrementId` + stale cursor -> state conflict
- different `incrementId` + current cursor -> new authoritative attempt

canonical fingerprintには`additionalUnits`とcanonicalized `{ budgetKey, limit }` listを含める。Store-specificなnext cursorはfingerprintに含めない。

## Atomic admission

new growth attemptではStore transaction内で以下を一体化する。

1. reservationがactiveであることを証明
2. supplied cursorがcurrentであることを証明
3. budget key setがreservationと一致することを証明
4. 既存pending/liable ruleに従ってexpiryをrecover/reject
5. 全participating budgetのauthoritative usageを読む
6. 全budgetで`additionalUnits`が収まるか判定
7. attempt resultを記録しcursorをrotate
8. acceptedなら全budget usageと`reservedUnits`を同一transactionで増加

partial growthは禁止。1 budgetでもdenyならcapacityは全budgetで不変。

## Pending / liable semantics

Growthはreservationの現在のliability stateを継承する。

- **pending + accepted growth:** 追加capacityもpending。`markLiable`前にexpireしたらgrowthを含む全reserved capacityをreleaseする。
- **liable + accepted growth:** execution開始済みのため追加capacityも即cost-liable。expire時はgrown reservation全量をconservativeにretain/chargeする。
- `grow`自体はpending -> liableへ遷移せず、TTLもrenewしない。

`grow`と`markLiable` raceはStore transaction orderで解決する。pending中にgrowth commit後にreservation全体がliableになるか、先にmarkLiableがcommitしてgrowthがliable stateを継承する。

## Settlement

`reservedUnits`はsuccessfully reserved capacityの合計。

`initial reserved units + successfully committed growth units`

authoritative quota denialは`reservedUnits`を変更しない。

settlementは引き続き次をrejectする。

`actualUnits > reservedUnits`

grown totalと完全一致するsettlementはvalid。

## Races

### concurrent same increment

1 transactionだけがnew attemptを評価し、他は同じrecorded resultをreplayする。capacity increaseは最大1回。

### concurrent distinct increments

current growth cursorをconsumeできるのは1 contenderだけ。他はstale cursorでfail closed。複数increaseはreturned cursorを使ってserializeする。

### grow vs settle

- growth first: settlementはgrown totalを見る
- settlement first: earlier incrementのreplayを含む全growth callをreject

settlement後にgrowth successを返してはいけない。retained replay metadataは後続reconciliationには使えても、追加metered workのauthorizationには使わない。

### grow vs expiry/recovery

reserve/settleと同じtransaction/serialization boundaryでgrowthを保護する。

- growth before pending expiry: recoveryはgrown totalをrelease
- growth before liable expiry: recoveryはgrown totalをretain
- expiry/recovery first: earlier incrementのreplayを含む全growth callをreject。replayでexpired leaseを復活させない

## Provider ambiguity

Store/provider errorはquota denialでもcontinue許可でもない。callerは追加metered workを止め、Storeがauthoritative replayを証明できるまで**same increment identity**をretryするかoperationをfail closedする。

後続releaseでstatus/reconciliationが追加されても、v0.6 growth correctnessはoptimistic reconciliationへ依存しない。

## Storage compatibility

Growth metadataはadditive/optionalに読む。

- v0.5 reservation/tombstoneはfixed-reservation semanticsのままreadable
- growth metadata導入前のreservationを暗黙にgrowableへupgradeしない
- v0.6 growth-capable Storeがsafe growthに必要なcursor/replay fieldsを書く
- cleanup/recoveryは対応するreservation/tombstoneを保持する間replay metadataも保持し、後続reservation incarnationへstale metadataを再利用しない

provider migrationはbackward-compatibleにし、Storeがgrowth supportをadvertiseする前に適用する。

## MCP usage pattern

安全なpattern:

1. small bounded amountをreserve
2. metered work直前にmark liable
3. current reserved capacity内だけwork
4. capacity超過前にstable `incrementId`でbounded growthを要求
5. authoritative accepted後のみcontinue
6. quota denial / unresolved ambiguityならadditional metered workを開始せずsafe stop/finalize
7. successfully reserved total以内でactual usageをsettle

multi-round MCP / Tasksでもsame logical operation + same reservation identityを維持する。second reservationをtop-up代替にしない。

## v1 decision gate

Memory / Redis / Cloudflare Durable Objects / Firestoreのportable proofとprovider-specific concurrency/ambiguity testsが全部通った場合のみfuture v1 stable surfaceへ採用する。成立しない場合は#83をv1から明示的にdeferred/excludedとし、bounded fixed-reservation modelをv1 contractとして確定する。
