---
"@kindgi/api": patch
"@kindgi/env-schema": patch
---

Page cursors can be sealed. A list that hides rows the caller can't read after fetching them handed out its binding's cursor, a readable position that could name one of those rows (its id or time).

- **What it does:** with `cursorSealer` (`createAeadCursorSealer`, AES-256-GCM), every list's cursors are sealed at the API's edge. A GET's sealed `cursor` opens to its position before any route reads it, and a JSON answer's `nextCursor` is sealed on its way out. A sealed cursor shows nothing of the row it points after.
- **Where it opens:** only for the tenant, caller, list and filters it was handed out for, within a day. Otherwise `400 bad-input`, and the client starts again without it. The page size may change mid-scan. A plain cursor still passes.
- **Keys:** each carries a `kid`. The first key seals and any listed key opens, so a key can rotate.
- **Approvals:** with sealed cursors, `GET /v1/approvals` continues after the last approval it fetched once the page holds every one of that window the caller may read. A window of approvals the caller can't read no longer ends the paging: the page is empty, with `hasMore` and a cursor.
- **Without a sealer:** cursors are the bindings' own, as before.
- **The runtime's key:** `@kindgi/env-schema` lists `KINDGI_PAGINATION_KEY(_PATH)` and `KINDGI_PAGINATION_PREVIOUS_KEY(_PATH)` (for `--help` and the environment reference). Without a key, a cursor from before a restart answers 400 after it, and more than one instance needs the key. Keep the previous key at least a day after rotating, and rotate yearly. A cursor sealed with a key the runtime doesn't have says so (`unknown-key`). A list's filters bind as `[name, value]` pairs.
