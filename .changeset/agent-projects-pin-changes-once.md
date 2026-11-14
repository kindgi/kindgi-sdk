---
"@kindgi/api": patch
---

`GET /v1/agents/:agentId/projects` now reads each pin change once, however many projects its pin covers, and at most four at once, instead of one read per pinned project, all at once. The rows, and their order, don't change. A failure answers as reading the projects in turn does: once one fails no more projects start, the reads running end, and the answer is the failure of the earliest project. With reads running together, a busy database can answer `503 database-busy` in its place.
