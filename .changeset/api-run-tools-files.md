---
"@kindgi/api": patch
---

**A chat's run tools read a run's files from `/v1/files`.** `kindgi.run_state` and the agent and flow tools list a done run's files with `GET /v1/files?ownerRunId=`, and each file in `structuredContent.files` gains `fileId` and `version`, its Latest. On a server that doesn't serve `/v1/files`, they read `/v1/artifacts` and answer without the two fields.
