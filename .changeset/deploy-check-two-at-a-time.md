---
"@kindgi/api": patch
---

The check against what runs (`checkAgainstRuns`), which `POST /v1/deployments`, `POST /v1/deployments/check` and a pinning promotion use, now reads the pack's agents two at a time, then its blocks two at a time, instead of one after another, so a pack with many agents or blocks is checked sooner. The answer, and its order, don't change. A failure answers as before: once one fails no more start, the reads running end, and the answer is the failure of the earliest agent, or of the earliest block, in the pack's order. With reads running together, a busy database can answer `503 database-busy` in its place.
