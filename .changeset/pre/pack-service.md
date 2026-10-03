---
"@kindgi/handler-runtime": minor
"@kindgi/tools": minor
"@kindgi/agents": minor
---

A pack service to run a pack's code over HTTP (pack protocol v2), and tools learn which run they belong to.

- `@kindgi/handler-runtime`:
  - New `./protocol` (v2): tool and check requests name the tool or check by id, and responses are `result`, `check-result` or `error` messages with typed codes (including `tool-not-in-pack`, `tool-version-mismatch`, `deadline-exceeded` and `cancelled`).
  - New `./pack-service`: `createPackService` and `startPackService` expose `POST /v1/invoke`, `GET /v1/info`, `/healthz` and `/readyz`, with token auth, a concurrency cap, a body limit, deadlines, cancellation on disconnect, prewarm and drain.
  - New `./pack-service-main`: the process entry (`KINDGI_PACK_SERVICE_TOKEN`, `KINDGI_PACK_INDEX`, `KINDGI_PACK_SERVICE_MAX_CONCURRENCY`, `PORT`; SIGTERM drains).
  - `HandlerContext.abortSignal` (in-process calls only) lets handlers stop on cancel or deadline.
  - The v1 worker, controller and invokers are unchanged.
- `@kindgi/tools`: `ToolContext.runId`, the kernel run a call belongs to. `requestId` stays the individual call's id.
- `@kindgi/agents`: agent tool calls set `runId` to the turn's kernel run. They used to pass only the model's call id.
