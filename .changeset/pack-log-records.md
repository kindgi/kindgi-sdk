---
"@kindgi/handler-runtime": patch
"@kindgi/tools": patch
"@kindgi/cli": patch
---

The TypeScript pack service writes `@kindgi/log` records on stderr (subsystem `pack`), the same schema as the runtime's: one record per call carrying the call's `tenantId`, `runId`, `requestId`, `toolId`, its outcome and duration, and the caller's `traceId` from the `traceparent` it sent. The lifecycle (`listening`, `boot-failed`, `config-invalid`, `draining`, `stopped`) is written whatever the levels; `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT` apply to the rest (`auto` is JSON unless stderr is a terminal). The service's records keep `kind` beside `event`, so an older supervisor still reads them.

`ctx.log` (an optional `ToolContext.log`): a logger bound to the call, so a tool's own records carry the run's ids and trace (`ctx.log.info('looked up order', { orderId })`, subsystem `pack.tool`). `kindgi dev` shows them as `[pack]` lines.

The supervisor reads records and older bare events, acts only on the service's own lifecycle, and no longer swallows the pack's own JSON output that happens to have a `kind` field. It runs its child with `KINDGI_LOG_FORMAT=json`. `createPackService` takes `log`; its `logger` callback still gets the events.

The supervisor's front passes the caller's `traceparent` on to the pack service, so under `kindgi dev` a call's records carry the runtime's trace too. It dropped the header before.
