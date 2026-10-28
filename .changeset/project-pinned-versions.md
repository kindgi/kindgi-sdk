---
"@kindgi/api": patch
"@kindgi/client": patch
---

**Every pin that covers a project, in one read.** `GET /v1/projects/{projectId}/pinned-versions` (`client.projects.pinnedVersions.list(projectId, { limit, cursor })`, and `projects.pinned_versions.list` in the Python client) answers `{ data, hasMore, nextCursor? }`: every agent's pins that cover the project (the tenant's, the project's org's, the project's own and its segments'), ordered by agent, then by scope, each as `GET /v1/agents/{agentId}/live-versions` shows it. It pages like the promotions list: `limit` is 25 by default and 100 at most, and a cursor the binding didn't issue is `400 bad-input`.
- **Who sees what:** it takes `read` on the project, checked before the cursor, the limit or anything else. Then it lists only the pins of agents the caller can read, each at its own version, and only versions the caller can see, as an agent's own list does. So a page can hold fewer pins than `limit`, or none, with `hasMore` true: page on `nextCursor`, not the count.
- **The binding:** `LiveVersionBinding.listCovering` (`ListCoveringPinsInput`) and `issuedCursor('covering', cursor)` are optional. Without `listCovering`, the route answers `501 pinned-versions-not-supported`. The route mounts with `agentReleases` and `projectBinding` both given.
