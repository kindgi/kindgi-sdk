---
"@kindgi/cli": patch
"@kindgi/env-schema": patch
---

**`kindgi exports create` records the runtime's version.** `manifest.json` gains an optional **`runtime`** (`{ version }`), as `GET /v1/runtime` answers it, so whoever reads the export later knows which release's API shapes its records follow. It's there only when every read found the same version: it's left out for a runtime that doesn't answer it, and for an export whose runtime was upgraded while it ran or between a run and its `--resume`. The command's description now says that an export is the workspace's own copy of its records, not a backup to restore: no runtime loads one.

**`KINDGI_TENANT_ID`'s description says what an unset id does.** A runtime serving one tenant seeds a new tenant at every start when it's left unset, so the description says to set it, in lower case, on any runtime you keep, and to give each runtime its own id.
