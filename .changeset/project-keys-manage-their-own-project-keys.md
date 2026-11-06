---
"@kindgi/api": patch
"@kindgi/client": patch
---

**Breaking, for API keys limited to a project.** Such a key, or a session limited to a project, lists, reads and revokes only its person's keys limited to that same project. Before, it listed every key of its person and could revoke any of them, a key for another project or for none included. Another key now reads as missing to it: `GET /v1/tokens` leaves it out, and `GET /v1/tokens/{tokenId}` and `POST /v1/tokens/{tokenId}/revoke` answer `404 not-found`. This holds for an `admin` key of a tenant admin too, since a key limited to a project is never a tenant admin.

`TokenListInput` gains an optional `projectId`: the route sets it for such a caller, and a store that applies it keeps its pages full. The route also leaves out any other key a store returns, cutting the page where the store's was, so a store that doesn't apply it shows shorter pages, never another project's keys.

A key or a session that isn't limited to a project sees its keys as before. The API reference and the TypeScript client's `tokens` docs say so.
