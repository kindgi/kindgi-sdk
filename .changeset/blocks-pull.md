---
"@kindgi/cli": patch
---

**`kindgi blocks pull`** writes the newest version of each block that runs anywhere into the pack's block file, where it's newer than the file, and prints what it wrote and what it left. It reads `GET /v1/blocks/{blockId}/runs-in` and needs read on the projects. Name blocks to pull only those; `--path` points at a pack in another directory. A file already newer than anything that runs is left as it is, so an edit not yet deployed is never taken back.
