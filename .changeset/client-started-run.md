---
"@kindgi/client": patch
---

`runs.start()` returns `StartedRun`: the run plus `publicAccessToken` and `publicAccessTokenExpiresAt`, which `POST /v1/runs` returns when the deployment issues public run tokens. TypeScript callers no longer need a cast to hand the token to a browser.
