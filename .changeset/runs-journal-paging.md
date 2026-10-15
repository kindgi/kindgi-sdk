---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**`GET /v1/runs/:runId/journal` pages when asked: `limit` and `cursor` now work.**
- With `limit` (1 to 100), the answer holds at most that many entries after `cursor` (and `since`), with `hasMore` and a `nextCursor` while more remain. Without `limit`, the whole journal comes in one answer, as before, so a caller that doesn't page sees no change.
- A malformed `cursor`, or a `limit` that isn't a whole number of 1 or more, is `400 bad-input`.
- `nextCursor` is a new optional field of the page. The Python client's `runs.journal` gains `limit` and `cursor`. The TypeScript client's `runs.journal(runId, { limit, cursor })` and `kindgi runs journal --limit --cursor` already took them, and the server now reads them.
- The TypeScript client's `since` doc now says what the server does: only entries with a sequence greater than it.
