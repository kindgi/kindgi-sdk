---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**An agent's corrections export as CSV or JSON lines.** `GET /v1/corrections/export?agentId=<agent-id>` streams every correction of the agent that the list's filters match, without paging: `format=csv` (the default, with a header row) or `format=jsonl` (one correction per line, as the list sends it). It takes no `limit` or `cursor`. Each correction comes only when the caller may read its project, and a project scope it can't read is a 403. A CSV field a spreadsheet would run as a formula gets a leading `'`. Each export is recorded in the audit log as `corrections-export-started` and `corrections-exported` (the rows sent, and `succeeded` or `failed`); when the first can't be written, the export is a 500 and sends nothing. The TypeScript client's `corrections.export(filter)` returns the body as a `ReadableStream`. `kindgi corrections export --agent=<agent-id>` prints it, or with `--out=<file>` writes the file, readable only by its owner, once the whole export has arrived, keeping an existing file unless you add `--force`; it takes `--project`, `--status`, `--sorted-to`, `--from`, `--since`, `--until` and `--format=jsonl`. The OpenAPI document marks a streamed operation with `x-kindgi-streamed`.
