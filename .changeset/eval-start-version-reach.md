---
"@kindgi/api": patch
---

**Starting an eval run checks the version it names.** `POST /v1/eval-suites/{suiteId}/runs` with an `agentRef` or `flowRef` that names a `version` now asks the runtime whether `projectId`'s project runs that version, not only whether it reaches the agent or flow. If it doesn't, for example a version made in an earlier environment of an environment order and not yet promoted to this one, the start is refused with **`400 reference-out-of-scope`** and nothing runs. Before, the start answered `201` and every case's replay was then refused.
- The refusal's message, and the message of its issue at `/agentRef/agentId` or `/flowRef/flowId`, name the version and say it's the version the project doesn't run: `agent "acme.desk" 1.1.0 isn't a version this project runs (not registered in this project, its org or the tenant, nor deployed to it)`.
- A start that names no version is checked as before, by the agent's or flow's id.
- A flow candidate's `versions` are checked the same way, each at its own path: an agent at the version named, at `/versions/agents/<id>`, and a tool by its id, at `/versions/tools/<id>`.
- `referencesOutOfScope` names the version of a reference that has one, in each issue's message and in the refusal's, and says it's a version the project doesn't run. A reference without a version is refused with the same words as before.
