---
"@kindgi/agents": patch
"@kindgi/runtime": minor
---

A turn parked on a tool-call approval resumes where it parked.

- `@kindgi/agents`:
  - **Fix: `resumeAgentTurn` after a tool-call approval.** It used to fail with `model-invocation-failed` ("model-call invoked before setup completed"), because the steps that ran before the park kept their state in memory. The turn now rebuilds that state:
    - its environment (conversation, guardrails, tools, policies), routed to the provider and model the turn started on. If that provider or model is no longer registered or allowed, the resume fails with `capability-routing-failed`.
    - the messages the turn stored, its retrieved facts, and its usage, so budgets count the whole turn.
  - **No repeats.** The step that parked runs again. It reuses the assistant message and the results of calls that ran before the park, so no call runs twice and nothing is stored twice.
  - **Errors.** `run-journal-unavailable` when the run's journal can't be read.
  - **Not rebuilt: provenance.** Provenance recorded before the park isn't rebuilt; the resumed turn's record starts at the resume.
- `@kindgi/runtime`:
  - `DerivedRunState.completedBodySteps`: the loop-body steps that completed, by `bodyStepKey(nodeId, loopContext)`. A runtime replaying a loop on resume hands those steps their journaled results instead of running them again.
  - `CompletedBodyStep` and `bodyStepKey`.
