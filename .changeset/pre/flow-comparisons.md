---
"@kindgi/api": patch
"@kindgi/client": patch
---

Comparison eval runs take a flow version as the candidate. On a test set built from a flow's judged runs, `POST /v1/eval-suites/{suiteId}/runs` with `flowRef: { flowId, version }` replays each case on that flow version (from the past run's input) and scores the flow's whole output against the judgments.

A replayed flow stops at a tool call the replay refuses (a write the past run didn't make), so no made-up value reaches its next step. The case ends `stopped`, with what it would have done. It isn't an error and is left out of the metrics. The summary counts these cases in `stopped`, next to `errors`, and the run's status stays `completed` when cases only stopped.

The summary's `candidate` now says what ran, `{ kind: 'agent', agentId, version }` or `{ kind: 'flow', flowId, version }`, and `baseline.versions` names a flow's recorded versions as `{ flowId, version, cases }`. The subject invoker reports a stop through `EvalRunSubjectInvokeOutcome.stopped`.
