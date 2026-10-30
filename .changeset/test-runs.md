---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
"@kindgi/agents": patch
"@kindgi/capabilities": patch
"@kindgi/compliance": patch
"@kindgi/provenance": patch
"@kindgi/runtime": patch
"@kindgi/specs": patch
---

**Eval runs are now test runs.** This is a breaking rename, and no old name is kept.

- **Routes.** `/v1/eval-runs` is `/v1/test-runs`, with `{testRunId}` in its paths; `cancel`, `events` and `rescore` keep their sub-paths. `POST /v1/test-sets/{testSetId}/runs` still starts one.
- **Fields and values.**
  - A test run's own id is `testRunId`: in the start and rescore answers, the run view and the list rows, where it was `runId`. Ids of agent runs, such as a case's `runIds`, keep their names.
  - `evalRunId` is `testRunId` everywhere it names a test run: in the agent pin body, in a run's replay marker (`{ of, testRunId }`), in a replay's provenance, and in `/v1/runs`'s filter.
  - The stream's events `eval-run.completed`, `eval-run.failed`, `eval-run.cancelled`, `eval-run.case-completed` and `eval-run.case-failed` are `test-run.*`, with the same endings.
  - The compliance evidence kind `eval-run` is `test-run`.
  - `GET /v1/compliance/evidence?kind=` answers 400 for a kind that is neither a built-in evidence kind nor one the classifier names, such as `eval-run`. It was an empty page. A kind the classifier names but doesn't mark exportable is still an empty page.
- **Errors.** Codes starting `eval-run-` start `test-run-`.
- **Schemas and types.** `EvalRun*` names are `TestRun*`. A comparison's `EvalComparison`, `EvalBaseline`, `EvalOverrides` and `EvalSample` are `TestRunComparison`, `TestRunBaseline`, `TestRunOverrides` and `TestRunSample`, and the types `EvalReads` and `EvalGroupWeights` are `TestRunReads` and `TestRunGroupWeights`.
- **TypeScript client.** `client.evalRuns` is `client.testRuns`.
- **CLI.** `kindgi eval-runs` is `kindgi test-runs`, and `--eval-run` is `--test-run` (on `kindgi agents pin` and `kindgi runs list`). `kindgi exports create` writes them as `test-runs`.
