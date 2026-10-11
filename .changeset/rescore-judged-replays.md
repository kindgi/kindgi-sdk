---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

A comparison can now be rescored after people judge its new answers. A changed free-text answer is a new item that no test-set judgment covers, so a comparison had no evidence for it, and a proposal changing a reply ended `not-better`.
- **Judge the new answers:** a comparison's `perCase[].changes.new` lists each changed item with its replay run (`runIds`). Judge it on that replay, as you'd judge any run. The console's Judge buttons do the same.
- **Rescore:** `POST /v1/eval-runs/{runId}/rescore` (`kindgi eval-runs rescore <run-id> [--wait]`, client `evalRuns.rescore`) starts a new comparison that replays nothing. It scores the run's replays again, counting the judgments recorded on them since, with the comparison's class weights. The run rescored stays as it was; the new one names it (`comparison.rescoreOf`, `summary.rescoreOf`).
- **What the evidence says:** a score's `fresh` sums, a new item's `judged`, and a metric's `freshWeight` say how much came from judging the replays. A case whose replays can't be read again keeps its scores (`rescored: false`, `summary.notRescored`).
- **Refusals:** a runtime that can't read replays and their judgments again answers `400 dispatcher-input-invalid`. A run that isn't a completed comparison of a test set is `409 eval-run-not-rescorable`.
- **Bindings:** `EvalRunStartInput.suiteVersion` (optional) pins the suite version a run uses. `EvalRun.projectId` (optional) names the run's project. `createJudgedDispatcher` takes optional `evalRuns`, `runs` and `judgments` readers for rescores.
