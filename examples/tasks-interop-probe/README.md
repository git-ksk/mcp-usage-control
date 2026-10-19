# Upstream MCP Tasks receiver capability gate (#272)

The 2026-07-28 Tasks **schema** is stable; this fixture checks the separately
published **runtime** receiver capability with exact versions, not package
README claims alone. It is deliberately outside `pnpm-workspace.yaml` and must
not become a mandatory release dependency.

```sh
cd examples/tasks-interop-probe
npm install --ignore-scripts --no-package-lock --no-audit --no-fund
npm test
```

Proves for `@modelcontextprotocol/ext-tasks@0.2.2` with official
`@modelcontextprotocol/client@2.3.1` and `server@2.3.1`:

- The receiver binds to an SDK **Client**, supports legacy `tasks/list`,
  `tasks/get`, `tasks/result`, `tasks/cancel`, and is configured for task-backed
  *sampling/elicitation*.
- Neither `tools/call` nor `tasks/update` is installed by the receiver;
  an attempted `tools/call` receiver registration rejects. The requester-side
  helper's existence does **not** supply a 2026-07-28 server receiver.
- Hence modern Tasks `tools/call` creation / `tasks/update` lifecycle and
  cancel/crash/recovery cannot be genuinely tested against an official
  2026-07-28 receiver in this exact peer matrix.

**Decision: DEFER a first-class 2026-07-28 Tasks server accounting adapter.**
Continue documented application-owned tasks accounting with existing usage
leases; reconsider #275 when upstream proves full server receiver interop.
Do not polyfill unsupported wire methods, claim stable server support, or
make task status authoritative for usage/cost liability.

This is a narrow negative compatibility proof. It is **not** an end-to-end
receiver implementation, a correctness proof for future SDK versions, or a
claim that requester/client Tasks execution is absent.
