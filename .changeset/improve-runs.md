---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
"@kindgi/runtime": patch
---

**Improvement passes are now Improve runs.** This is a breaking rename, and no old name is kept.

- **Routes.** `/v1/improvement-passes` is `/v1/improve-runs`, with `{improveRunId}` in its paths; `cancel` keeps its sub-path. `POST /v1/proposals/improve` is `POST /v1/improve-runs`, and `POST /v1/proposals/improve/estimate` is `POST /v1/improve-runs/check`, with the same body and answer. Nothing is left on `/v1/proposals`.
- **Fields and values.**
  - `passId` is `improveRunId` everywhere it names an Improve run: on a schedule's fire and on a suggested change's `madeBy`.
  - In the API and the clients, a suggested change's `drafter` is `madeBy`, and its `hypothesis` is `why`, also in the body that creates one and in an Improve run's comparisons.
  - An Improve run's outcome `proposed` is `suggested`.
  - The webhook type `improvement-pass.finished` is `improve-run.finished`, and its `data.pass` is `data.improveRun`.
  - A test run's `passCount` keeps its name: it counts the cases that passed.
- **Errors.** `improvement-pass-not-found` and `improvement-pass-finished` are `improve-run-not-found` and `improve-run-finished`.
- **Schemas and types.** `ImprovementPass*` names are `ImproveRun*`. The start body is `StartImproveRunBody` (was `ImproveBody`), for both start and check, and the check's answer is `ImproveRunCheck` (was `ImprovementPassEstimate`). The schema `SuggestedChangeDrafter` is `SuggestedChangeMadeBy`; the binding's `drafter` field and its `SuggestedChangeDrafter` type keep their names. The runtime binding's schedule fire names its Improve run `improveRunId`.
- **TypeScript client.** `client.improveRuns` holds Improve runs, with `start`, `check`, `list`, `get` and `cancel`; `client.improvementPasses` and `client.proposals` are removed. Their inputs are `StartImproveRunInput` and `CheckImproveRunInput`. `@kindgi/sdk` re-exports `ImproveRunsClient` where it re-exported `ProposalsClient`.
- **CLI.** `kindgi improve runs start` starts one (was `kindgi proposals improve`), and `kindgi improve runs list`, `get` and `cancel` replace `kindgi proposals passes`; `kindgi proposals` is removed. `--pass-project` is `--run-project`, `<pass-id>` is `<improve-run-id>`, and `kindgi suggested-changes draft --hypothesis` is `--why`. `kindgi exports create` writes them as `improve-runs`.
