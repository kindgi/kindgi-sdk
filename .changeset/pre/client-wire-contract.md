---
"@kindgi/client": patch
---

Client requests now match what the API accepts.

- `agents.define(spec, { projectId, idempotencyKey? })`, `flows.define(flow, { projectId, idempotencyKey? })`, `guardrails.author(spec, { projectId, idempotencyKey? })`, `evalSuites.publish(input, { projectId, idempotencyKey? })` and `evalRuns.start(suiteId, input, { projectId, idempotencyKey? })` send `projectId` in the request body. `POST /v1/agents`, `/v1/flows`, `/v1/guardrails`, `/v1/eval-suites` and `/v1/eval-suites/:suiteId/runs` require it, so a call without it always failed with `400 bad-input`. The options argument is now required (types `DefineAgentOptions`, `DefineFlowOptions`, `AuthorGuardrailOptions`, `PublishSuiteOptions`, `StartEvalRunOptions`); `PublishSuiteInput` and `StartEvalRunInput` leave `projectId` out.
- `runs.start({ agent, projectId?, … })` sends `projectId` for agent runs too; it was sent only for flow runs.
- `approvals.list` and `conversations.list` take one `status` (`ApprovalFilter.status` / `ConversationFilter.status` no longer accept an array). The API filters by a single `?status=` and rejected the comma-joined value the client used to send; several statuses are now rejected client-side with `invalid-request`, before any request.
