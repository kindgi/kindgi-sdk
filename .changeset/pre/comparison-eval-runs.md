---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

Comparison eval runs: an agent version run on a test set, beside the recorded runs.

- **`@kindgi/api`:**
  - **Starting the run.** `POST /v1/eval-suites/{suiteId}/runs` on a `judged` suite (a test set) is a comparison. `agentRef` with its `version` is the candidate. The new body fields are `baseline` (default `'recorded'`), `reads` (`recorded` or `live`), `repetitions` (1–10) and `k` (1–100), and the run keeps them as `comparison`. Only `baseline: 'recorded'` runs today; `{ agentId, version }` and `{ live: … }` are accepted by the contract and refused when the run starts.
  - **The dispatcher.** `createJudgedDispatcher({ cases })` replays each case on the candidate. It goes through the subject invoker, with `replay: { of, evalRunId }` and the case's history, so the replay does nothing the past run didn't. It scores the candidate's output items against the judgments.
  - **Matching items.** A judgment carries over to the same item: the same own id, or, for the answer and elements without an id, the same content.
  - **The result.** `result.summary` (`JudgedComparisonSummary`) has:
    - the baseline (the versions behind the recorded runs) and the candidate;
    - `cases`, `diverged` (a read with no recording ran live), `refusedWrites` and `errors`;
    - the models that answered;
    - `metrics`: `weightedYesShare`, `judgedCoverage` and `weightedPrecisionAtK`, each with the baseline, candidate and delta and the evidence on both sides (`n`, `weight`, `baselineN`, `baselineWeight`), plus `k` and `spread`.

    `result.perCase` has each case's replay runs, the items kept, dropped and new, and its tool calls.
  - **Exports.** The item functions (`outputItems`, `matchJudged`, `scoreItems`, `itemChanges`) are exported. Test sets record the project their judgments came from (`spec.projectId`).
- **`@kindgi/client`:** `evalRuns.start` takes the new fields, and the Python client does too.
- **`@kindgi/cli`:** `kindgi eval-runs start | show | list | cancel`. `start` takes `--agent` with `--agent-version` (or `--flow`), `--baseline`, `--reads`, `--repetitions`, `--k`, `--dry-run` and `--wait`.
