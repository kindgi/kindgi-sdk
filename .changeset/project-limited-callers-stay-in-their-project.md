---
"@kindgi/api": patch
"@kindgi/client": patch
---

**Breaking, for keys and sessions limited to a project.** Such a caller now acts only inside its project. Before, some routes let it act for its person in every project:

- It neither lists nor revokes its person's sessions (`GET /v1/identity/users/{userId}/sessions`, `POST /v1/identity/users/{userId}/revoke-sessions`), even its own person's. A session limited to a project doesn't read, set up or take off its person's second factor (`/v1/identity/me/second-factor` and the routes under it). Each answers `403 permission-denied`, naming the project.
- `GET /v1/identity/users/{userId}/grants` shows its person's role in that project only, as `GET /v1/identity/me/permissions` lists it.
- On `/v1/connections` it lists and reads only the connections its runs in that project may use: those whose registration lets the project use them. Another reads as missing, `404 connection-not-found`, and a connection's choices show only that project's. It connects, finishes a connect, renames, changes and disconnects nothing: `403 permission-denied`.
- On `/v1/memory` it writes only in that project or one of its conversations. A fact in any other scope, its person's own included, is refused with `403 permission-denied`, whether made, changed, verified or deleted. What it reads doesn't change.

A key or a session that isn't limited to a project keeps today's rules. The API reference, the TypeScript client's docs and the docs pages on keys, connections and memory say so.
