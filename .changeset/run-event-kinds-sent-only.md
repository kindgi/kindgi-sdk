---
"@kindgi/api": patch
"@kindgi/specs": patch
"@kindgi/client": patch
---

**The run stream's event kinds list only what it sends.** Eight kinds were declared and never sent: `run.queued`, `run.tool-invoked`, `run.tool-result`, `run.model-token`, `run.artifact-produced`, `run.guardrail-violated`, `run.approval-requested` and `run.approval-completed`. They're gone from `RunEvent.kind` in the API reference, from `run-event.schema.json` (schema-version 1.1.0) and from the TypeScript client's `RunEventKind`. The stream sends the same events as before. TypeScript that compares a `RunEventKind` with one of the eight stops compiling, and can drop that branch, since it never ran. A kind comes back on the list with the stream that sends it.
