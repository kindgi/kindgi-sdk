---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**An erasure waits for a test run still going with a case from the person's runs.** It shows `waiting-on-run`, with `waitingOn` naming the test run, until its deadline, as for a run in a flow that serves other people; then the test run is cancelled and the erasure goes on. `resume --force` stops that wait too. The wire shape is unchanged: the `waiting-on-run` status, `waitingOn` and `force` text now name the test run.
