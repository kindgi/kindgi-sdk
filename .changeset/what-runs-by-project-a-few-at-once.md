---
"@kindgi/api": patch
---

`whatRunsByProject` now looks up its projects' pins a few at a time, at most two at once, instead of one after another, so an agent that runs in many projects answers sooner. What uses it answers sooner too: an agent's projects (`GET /v1/agents/:agentId/projects`), where a block runs (`GET /v1/blocks/:blockId/runs-in`), and what a deploy, a promotion or a pin change checks. The rows, and their order, don't change. A failure answers as before: the failure of the earliest project in the order given. With reads running together, a busy database can answer `503 database-busy` in its place.
