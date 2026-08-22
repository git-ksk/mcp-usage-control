# Cross-capability safety regression matrix

このmatrixは意図的に小さく保ちます。既存の縦型conformance suiteを置き換えず、複数capabilityが交差したときだけ現れる安全invariantを守ります。Cartesian productの全組み合わせは作りません。

| Safety invariant | Executable evidence | CI/backend |
| --- | --- | --- |
| zero-unit scalar/vector reservationを後からgrowしてもMemory retention上限を越えずfail-closedする | `packages/core/src/cross-capability-safety.test.ts` | Node 20/22/24 |
| windowed accounting identityがprogressive growth、mutable limit、replayを跨いでも元のkeyへ固定される | `packages/core/src/cross-capability-safety.test.ts` と `windowed-budget-keys.test.ts` | Node 20/22/24 |
| ambiguous progressive growthのexact-retry fenceがMCP suspend/resumeで失われない | `packages/mcp/src/cross-capability-safety.test.ts`、portable flow-store conformance、Redis `mcp-flow.test.ts` | Node matrix + live Redis 7 |
| liable expiry recovery後もreconciliationで通常settlementと区別できる | Firestore emulator `cross-capability: recovered liable reconciliation` | Firestore Emulator |
| active scalar/vector reservationが参照するbudgetをhistorical maintenanceがpruneしない | `packages/cloudflare/test/maintenance.mjs` | local workerd |
| malformed JavaScript discriminant / identityがTypeScript extension contractをすり抜けてmutationしない | core `runtime-boundary.test.ts`、Cloudflare `index.test.ts` / `authorization.test.ts` | Node matrix + transportが必要な箇所はworkerd |
| reconciliation / maintenance authがmalformed callbackやstreamed bodyでもfail-closedを維持する | Cloudflare `authorization.test.ts` | Node matrix |

provider-specific caseはRedis 7、Firestore Emulator、local workerdだけで実行します。live-cloud secretやdeployed Cloudflare testは追加しません。
