---
"@kindgi/api": patch
"@kindgi/platform": patch
---

A write whose body names a project it can't use is refused before anything is written: a `projectId` that isn't a project id (a UUID) is `400 bad-input` ("`projectId` must be a project id (a UUID)"), and one that names no project of the tenant is `404 project-not-found` (`details.projectId`). This covers `POST /v1/runs`, `/v1/tokens`, `/v1/agents`, `/v1/agents/{agentId}/versions`, `/v1/flows`, `/v1/tools`, `/v1/guardrails`, `/v1/eval-suites`, `…/versions/from-judgments`, `/v1/eval-suites/{suiteId}/runs` and `/v1/blocks`. Before, an unknown project failed the runtime's insert as a `500` whose message named a table and a foreign key. `POST /v1/conversations` keeps its documented `400 bad-input` for an unknown project. `@kindgi/platform`'s in-memory project binding makes UUID ids, as the wire's `Project.id` is.
