---
"@kindgi/api": patch
---

`GET /v1/blocks/:blockId/runs-in` now reads the agents that pin the block a few at a time, at most four at once, instead of one after another, so a block that many agents pin answers sooner. The rows, and their order, don't change. A failure answers as before: once one fails no more agents start, the ones running end, and the answer is the failure of the earliest agent in the order they pin the block. With reads running together, a busy database can answer `503 database-busy` in its place.
