---
"@kindgi/env-schema": patch
---

`KINDGI_ARTIFACTS` and `KINDGI_ARTIFACT_MAX_BYTES` say they serve `/v1/files` as well as `/v1/artifacts`, and that 0.8.0 renames them `KINDGI_FILES` and `KINDGI_FILE_MAX_BYTES`. With either one set, the runtime says so when it starts.
