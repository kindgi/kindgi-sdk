---
"@kindgi/cli": patch
---

**`kindgi exports create --out <dir>` exports the whole workspace as files,** through the API, as a tenant admin.
- **What it writes:** one `<kind>.jsonl` per kind of record the API reads (agents and their versions, runs and their journals, conversations and their messages, approvals, memory, env values, secrets' names and versions, people, keys, and the rest), one record per line, as the API answers it. A child kind's line is `{ "parent": { … }, "item": { … } }`. Artifacts' bytes go in `artifacts/`. `manifest.json` says what each file holds, and each kind's outcome: `ok` with its record count, `skipped` and why, or `failed` with the error.
- **The signed exports:** each decided approval's audit bundle, each run's provenance, and the compliance evidence, under `signed/`, when the server signs exports. `--no-signed` leaves them out, and with them their `export-signed` audit events.
- **What it never holds:** secret values (the API never answers them), pack images, and pack and run logs. The manifest lists them.
- **How it reads:** every list to its last page, env values and secrets at each env name and scope, and each item's own record where a list holds a summary. A `429` is waited out, and a `5xx` is sent again three times. A kind that fails doesn't stop the others, and the command exits 1. `--resume` finishes an export in the same folder, keeping the kinds already written. `--json` prints the manifest.
- **Someone who isn't a tenant admin** is stopped, with the kinds only an admin reads named; `--yes` exports what they may read.
- The `exports` group's description now covers both commands.
