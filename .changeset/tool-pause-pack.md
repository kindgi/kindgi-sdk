---
"@kindgi/specs": patch
"@kindgi/handler-runtime": patch
"@kindgi/tools": patch
"@kindgi/handler": patch
"@kindgi/pack-conformance": patch
"@kindgi/api": patch
---

**A pack tool can pause its run until another system answers (pack protocol 2.8.0).**

- **Declaring it:** a tool declares `pauses: true`. Its handler gets `ctx.waitToken`, `{ id, url }`: it hands the `url` to the system that will answer, then returns `ctx.pause({ timeoutMs, name })`. That system `POST`s its answer to the link as JSON, with no `Authorization` header: the link is the credential. The answer, valid against the tool's output schema, becomes the call's result. The handler may also answer at once, as any tool does.
- **How long:** `timeoutMs` is from 1 ms to 24 days (`MAX_PAUSE_TIMEOUT_MS`), and 24 hours when not given (`DEFAULT_PAUSE_TIMEOUT_MS`). A pause never waits forever. `name` says what the run waits for, in 1 to 200 characters.
- **Refusals:**
  - a tool with a declarative `spec` or an MCP transport can't declare `pauses`: `defineTool` answers `invalid-tool-definition`, and the indexer `manifest-validation-failed`;
  - a pause outside those bounds is `handler-shape-invalid`;
  - the new error `pause-not-available`: a call from a runtime that sends no wait token, or a pause from a tool that doesn't declare `pauses`. Reading `ctx.waitToken` throws then, so the tool fails before it hands anything on. Pausing needs a runtime that speaks pack protocol 2.8.0.
- **The protocol:** a tool's index entry carries `pauses: true` (pack index 1.5.0, tool manifest 1.2.0), and the call's context then carries `waitToken`. The pack service answers `{ v: 2, kind: 'pause', timeoutMs, name }`, each field only when the tool gave it. A tool that doesn't declare `pauses` never sees the token.
- **`@kindgi/handler-runtime`:** `runHandlerOrPause` returns a pause as a third outcome. `runHandler` keeps its two, and reports a pause as `pause-not-available`.
- **`@kindgi/tools`, for a runtime that calls tools:**
  - `invokeToolOrPause` returns `{ kind: 'pause', pause: { tokenId, timeoutMs, name } }` when the tool's handler returns `pauseOutcome(...)`. `invokeTool` reports a pause as `tool-pause-unsupported`;
  - a runtime that won't run a pausing call again throws `ToolRerunsExhaustedError` from the handler, and the call fails with `wait-token-reruns-exhausted`;
  - `wait-token-timed-out` is the error for an answer that didn't come in time;
  - `ToolContext.attempt` counts the runs of the call's step.
- **`@kindgi/handler`:** `NodeContext.attempt` counts the runs of a step, and `WAITPOINT_TIMEOUT_REASON` is the reason a wait that timed out resumes with.
- **`@kindgi/api`:** a tool's wire manifest (`Tool`) carries `pauses`.
- **Conformance:** the fixture pack gains `conformance.pause`, and targets gain a `pause` feature they may not support yet.
