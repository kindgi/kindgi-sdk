---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A retired agent, tool or test set can be found and brought back, as a flow can; and an eval run says which project it's in.**
- `GET /v1/agents/{id}/versions` and `GET /v1/eval-suites/{id}/versions` take `?includeTombstoned=true`, listing unregistered versions too, each with `unregisteredAt` (tools' versions already did). They answer for a retired one (every version unregistered) instead of `404`; only a never-registered id is `404`.
- `GET /v1/agents`, `/v1/tools` and `/v1/eval-suites` take `?includeRetired=true`, listing retired ones too, each as its highest version with `unregisteredAt`. `Tool` and `EvalSuite` gain an optional `unregisteredAt` for it. Both flags are off by default, and optional on the bindings (`AgentListInput`, `ToolListInput`, `EvalSuiteListInput`: `includeRetired`; `AgentListVersionsInput`, `EvalSuiteListVersionsInput`: `includeTombstoned`).
- `EvalRun` gains an optional `projectId`: the project the run was started in.
- The client: `includeRetired` on `agents.list`, `tools.list` and `evalSuites.list`; `includeTombstoned` on `agents.versions.list` and `evalSuites.versions.list`. `tools.list` rows are typed `ToolVersionRow`.
- The CLI: `--include-retired` on `agents list`, `tools list` and `eval-suites list`; `--include-unregistered` on `agents versions`. **`kindgi tools versions --include-tombstoned` is now `--include-unregistered`**, as `blocks` and `flows` say. The agents table shows `UNREGISTERED`.
