---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/env-schema": patch
---

**An erasure waits for a test run still going with a case from the person's runs, then cancels it.** Before, such a test run could still write that case's results after the erasure, with the person's words in them. The erasure shows `waiting-on-run`, with `waitingOn` naming the test run, until the deadline it keeps for a run in a flow that serves other people (`KINDGI_ERASURE_SHARED_WAIT_MS`, 7 days by default). Then it cancels the test run and goes on. `kindgi memory erasures resume <erasure-id> --force` (`force: true` over the API) stops the wait sooner. A test run with none of the person's cases isn't waited for. The wire shape is unchanged: the descriptions of `waiting-on-run`, `waitingOn` and `force` now name the test run.
