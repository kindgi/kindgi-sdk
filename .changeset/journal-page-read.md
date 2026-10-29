---
"@kindgi/runtime": patch
"@kindgi/api": patch
---

**A paged journal read reads only its page.** `RunBinding.readJournal` takes an optional `page` (the new `JournalPage`: `after`, a sequence, and `limit`), and gives only the entries after that sequence, at most `limit` of them. `GET /v1/runs/:runId/journal` asks the binding for its page alone, with one entry more than `limit` to tell whether more remain, so walking a long journal no longer reads all of it for every page. A run's event stream asks each read only for the entries after the last one it sent; it read the whole journal every 200 ms. A binding that ignores `page` and gives every entry stays correct: the route still filters and slices what it gets. The answers are unchanged.
