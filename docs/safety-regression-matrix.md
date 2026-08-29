# Cross-capability safety regression matrix

This matrix is intentionally small. It protects invariants that span two or more capabilities without replacing the vertical conformance suites or creating a Cartesian product.

| Safety invariant | Executable evidence | CI/backend |
| --- | --- | --- |
| Bounded Memory retention remains fail-closed when a zero-unit scalar/vector reservation later grows | `packages/core/src/cross-capability-safety.test.ts` | Node 22/24 |
| Windowed accounting identity remains pinned across progressive growth, mutable limits, and replay | `packages/core/src/cross-capability-safety.test.ts` and `windowed-budget-keys.test.ts` | Node 22/24 |
| Ambiguous progressive growth keeps its exact-retry fence across MCP suspend/resume | `packages/mcp/src/cross-capability-safety.test.ts`, portable flow-store conformance, and Redis `mcp-flow.test.ts` | Node matrix + live Redis 7 |
| Liable expiry recovery remains distinguishable during reconciliation | Firestore emulator `cross-capability: recovered liable reconciliation` | Firestore Emulator |
| Historical maintenance cannot prune budgets referenced by active scalar/vector reservations | `packages/cloudflare/test/maintenance.mjs` | local workerd |
| Malformed JavaScript discriminants/identity values cannot exploit TypeScript extension contracts | core `runtime-boundary.test.ts`, Cloudflare `index.test.ts` / `authorization.test.ts` | Node matrix + workerd where transport behavior matters |
| Reconciliation/maintenance auth remains fail-closed for malformed callbacks and streamed bodies | Cloudflare `authorization.test.ts` | Node matrix |

Provider-specific cases remain on local emulators/services only: Redis 7, Firestore Emulator, and local workerd. No live-cloud secret or deployed Cloudflare requirement is added.
