---
"@kindgi/api": patch
---

A conversation id that isn't one (a UUID) in `GET /v1/conversations/{conversationId}`, `…/messages` or `POST …/close` is `400 bad-input`: "`conversationId` must be a conversation id (a UUID)", as a run id is. Before, it reached the database and answered `500 persistence-error`.
