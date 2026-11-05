---
"@kindgi/cli": patch
---

**`kindgi exports create` exports deleted projects** (`deleted-projects.jsonl`), as a tenant admin reads them from `GET /v1/projects/deleted`: a deleted project is kept and can be restored. Anyone else skips the kind, and so does an export from a server that can't restore projects.
