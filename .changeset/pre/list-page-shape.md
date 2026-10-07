---
"@kindgi/client": patch
"@kindgi/api": patch
---

Every list call answers in one shape, the wire's page: `data`, `hasMore` and `nextCursor`, as the API and the Python client have it. The calls that answered `{ items, nextCursor }` (adapters, approvals, artifacts, capabilities, conversations, cost, events, flows, guardrails, judge classes, judgments, MCP, memory, observations, packs, policies, provenance, supervisor, tokens, tools and users) now answer `data` and `hasMore` too. `items` keeps working, marked `@deprecated`, and will be removed in 0.2. The client exports the page type as `ListPage<T>`.

`GET /v1/env`, `GET /v1/secrets` and `GET /v1/secrets/{name}/versions` send `hasMore`, and `GET /v1/auth/providers` sends `hasMore: false` (the list comes whole). Against an older server without it, both clients derive `hasMore` from `nextCursor`, so Python's `paginate(client.env.list, …)` and `paginate(client.secrets.list, …)` page through.
