---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/runtime": patch
"@kindgi/handler-runtime": patch
"@kindgi/specs": patch
"@kindgi/env-schema": patch
---

**Request logs and trace context.**

- **`createApp({ logger })`** takes a `@kindgi/log` logger. Without one, the app stays quiet.
  - Each request gets `c.var.log`, with subsystem `http` and its `requestId`, `traceId` and `spanId` (plus `tenantId` once authenticated), and `c.var.trace`.
  - An incoming `traceparent` is honoured, with a new span; a missing or malformed one starts a fresh trace. Every response answers `traceresponse`.
- **The access line:** `METHOD /v1/runs/:runId 200 12ms`, with the route's pattern and never the raw path.
  - Writes and 4xx are logged at `info`, 5xx at `error`.
  - Successful reads, probes and stream openings are logged at `debug`, so `info` stays readable while a console polls.
  - A 500 also logs the error itself, redacted.
- **Runs carry their trace.** Starting a run hands the request's trace to the run handler (`RunTrace` on the agent and flow invoke inputs). `RunFlowInput`, `StartRunParams` and `KernelRunRecord` take an optional `traceId`. `Run.traceId` is on the wire when a run has one: optional in the TypeScript client, `trace_id` in the Python client.
- **Pack protocol 2.4.1:** the optional `traceparent` request header (`PACK_HEADERS.traceparent`), so a pack service's records can carry the run's trace id.
- **`KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT`** are in the env schema, for the runtime server. Under `auto`, the format is pretty on a terminal or with `KINDGI_DEV=true`.
- **`kindgi dev`** runs the runtime with pretty logs (`KINDGI_LOG_FORMAT=pretty`) and keeps only its last 200 lines in memory.
