---
"@kindgi/handler-runtime": minor
"@kindgi/agents": patch
"@kindgi/sdk": patch
---

The pack service is the only way pack code runs. The old run-queue controller and the stdio worker are removed.

- **Breaking (preview), `@kindgi/handler-runtime`:**
  - **Removed:**
    - the run-queue controller (`managed-run-controller`) and its run fetchers (`HttpFetcher`, `InMemoryFetcher`);
    - the per-call sandbox invokers (`tool-sandbox-invoker`, `check-sandbox-invoker`);
    - the version-1 stdio worker protocol: its frames, `encodeFrame`, `parseStdinFrame(s)`, `runWorkerStdio`, the worker's `main` and `PROTOCOL_VERSION`.

    None of these had a caller. A pack image now runs the pack service, which replaced them.
  - **Removed exports:** `./managed-run-controller`, `./managed-run-worker`, `./fetchers/http`, `./fetchers/in-memory`, `./tool-sandbox-invoker` and `./check-sandbox-invoker`, and their names on the package root.
  - **The handler runner:**
    - `runWorker` is now `runHandler` (`RunHandlerOptions`), and the check runner is `runCheck` (`RunCheckOptions`), both exported from the package root. They're unchanged apart from the names.
    - `HandlerErrorCode` drops the four stdio-only codes (`malformed-stdin-frame`, `unknown-envelope-version`, `unexpected-frame-kind`, `stdin-closed`).
- **Fix: a guardrail check in the pack service gets the call's abort signal.** `runCheck` takes `abortSignal` and passes it as `bindings.abortSignal`, and the pack service passes its call's signal, which fires on the deadline or when the caller disconnects. Before, a check got empty bindings and kept running after its call ended.
- `@kindgi/agents`, `@kindgi/sdk`: comments and a skill's sources name the handler runner.
