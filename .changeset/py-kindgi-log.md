---
"@kindgi/client": patch
---

Python: `kindgi.log`, the same log records as `@kindgi/log`, with no new dependency. `get_logger("billing", tenantId=…)` gives a logger (`log.info("charged", {"amountCents": 1200})`, `log.child(runId=…)`, `err=exc`) at the levels and format of `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT` (`configure()`; a `TRACE` level), redacting secret-looking keys and known secret shapes. `JsonFormatter` and `PrettyFormatter` put an app's own `logging` records in the same schema. The shared vectors check that Python and TypeScript write the same records.

The Python pack service writes these records on stderr (subsystem `pack`), as the TypeScript one does: one per call, with the call's ids and the caller's `traceId`, and the lifecycle whatever the levels (each keeps `kind` for older supervisors). `ToolContext.log` is a logger bound to the call (`ctx.log.info("looked up order", order_id=…)`, subsystem `pack.tool`); in a test it writes nothing unless you pass one.
