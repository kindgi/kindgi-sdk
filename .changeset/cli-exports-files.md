---
"@kindgi/cli": patch
---

**`kindgi exports create` writes files and their versions.** A bundle gains `files.jsonl` (each file, with its Latest), `file-versions.jsonl` (each file's versions, deleted and purged ones included) and `file-pin-history.jsonl` (each pin and unpin). A live version's bytes are in the bundle already, as `artifacts/<blobId>`, so they aren't read twice.
