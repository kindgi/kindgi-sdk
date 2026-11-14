---
"@kindgi/api": patch
---

Correcting a run and adding it to an agent's test set share one refusal for a run without an output, and its words now fit both. A run that failed or was cancelled says it ended without an output and won't have one, instead of "no output to correct yet". A run that completed without an output says so, and only a run still going says "yet". An erased run says its content is gone, so a test case is no longer told there's nothing to correct. The codes stay `run-not-finished` and `run-erased`.
