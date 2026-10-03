---
"@kindgi/runtime": minor
"@kindgi/api": minor
"@kindgi/client": minor
---

Runs return their output, record which run started them, and can be started without waiting.

- `@kindgi/api`:
  - Run responses (`GET /v1/runs/:runId`, start, cancel, resume) include `output` once the run completed. Lists include it only with `?include=output`.
  - A child run carries `parentRunId` and `parentNodeId`. `GET /v1/runs` filters with `?parentRunId=` (a run's children) or `?topLevel=true`.
  - `POST /v1/runs` accepts `options.wait: false`: the binding returns the run id as soon as the run exists and the route answers `202`. The default still answers `201` once the run completes, fails or suspends. `InvokeAgentBindingInput` and `InvokeFlowBindingInput` gain `wait`.
  - `POST /v1/runs/:runId/resume` resumes the run through the host's run handler after completing the waitpoint; the run used to stay suspended. Waitpoint ids starting with `child:` are reserved for the runtime (`400`).
  - New status mappings: `flow-unbound`, `flow-runs-not-supported` and `flow-resume-not-supported` → `422`.
- `@kindgi/runtime`:
  - `ParentRunRef`, and `parent` on `RunFlowInput` / `StartRunParams`.
  - `RunFlowInput.runId` adopts a `pending` row created by `startRun`.
  - `HandlerResolver` (`handlerResolver` on `RunFlowInput` / `ResumeRunInput`) binds handlers for child flows.
  - `KernelRunRecord.parentRunId` / `parentNodeId` / `parentScope`; `ListRunsInput.parent` and `topLevelOnly`.
  - `KernelRunRecord.output` is documented as the output value itself, not a storage envelope.
- `@kindgi/client`: `Run.output`, `Run.parentRunId` / `parentNodeId`; `runs.list({ parentRunId, topLevel, includeOutput })`; `StartRunOptions.wait`.
