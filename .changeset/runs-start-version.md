---
"@kindgi/cli": patch
---

`kindgi runs start --agent-version=<v>` and `--flow-version=<v>` run that version instead of the latest. A turn in a conversation needs the version the conversation was opened with: before, a CLI turn in a conversation opened at an older version failed with `agent-version-mismatch`. A version for the other kind (`--flow-version` with `--agent`) is refused. `--project=<project-id>` runs it in that project instead of the tenant's Default one.
