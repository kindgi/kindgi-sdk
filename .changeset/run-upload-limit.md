---
"@kindgi/api": patch
"@kindgi/env-schema": patch
---

`createApp` takes an optional `runUploadLimiter`: a deployment's limit on what one person uploads to `POST /v1/artifacts` with `run` on the project and no `write`, a file of their own that names no run, for a run they start. Each such upload is checked with the workspace, the person and its size. Past the limit it's refused with `429 upload-limit-reached` and `Retry-After`, and nothing is stored; `details` carries the limit (`maxBytes`, `maxFiles`), what's used (`usedBytes`, `usedFiles`), `windowSeconds` and `retryAt`. An upload that passes on `write` is never checked. Without a limiter, uploads are as before. The new types are `RunUploadLimiter`, `RunUploadCheckInput` and `RunUploadCheck`. The environment reference adds `KINDGI_ARTIFACT_RUNNER_DAILY_BYTES` and `KINDGI_ARTIFACT_RUNNER_DAILY_FILES`, the runtime's settings for that limit: by default 1 GiB and 1,000 files per person in 24 hours in a workspace.
