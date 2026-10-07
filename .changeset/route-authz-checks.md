---
"@kindgi/api": patch
---

With authorization on, every route checks what it touches. A runtime without an authorizer, or a single admin, sees no change: the seed admin passes every check.
- **Never a relation the model lacks.** The authorizer refuses a check whose (type, action) pair isn't in `@kindgi/authz`'s `OBJECT_ACTIONS` before it reaches the store (`failing: 'invalid-action'`). OpenFGA would reject such a check, so it failed for everyone. `POST /v1/runs/:runId/resume` now checks `write` on the run's project, not `execute` on a project.
- **Tenant-wide settings ask for the tenant:** `read` to read, `admin` to change. That covers providers, policies, adapters, capabilities, signing keys, deployments and the sign-in provider catalog (`/v1/auth/providers`). Webhook endpoints and compliance evidence need `admin` for every call.
- **Changing the tenant's config needs `admin`.** `PATCH /v1/tenant/config` writes the tenant's secrets and env, and needed only `read`.
- **Runs:** starting one needs `execute` on the agent or flow it runs. The run list holds only runs in projects the caller may read.
- **Lists hold only what the caller may read:** agents, flows, tools, guardrails, eval suites, MCP endpoints, conversations, approvals, observations, cost records, provenance, eval runs, and event and webhook triggers.
- **Conversations:** reading one needs `read` on its project (or its agent). Opening or closing one needs `execute` on the agent.
- **Approvals:** a reviewer also needs `read` on the approval's project. Another project's approval answers `404`.
- **Cost and provenance:** a record needs `read` on its project. An aggregate needs `read` on the scope it asks about. A run's provenance and its export need `read` on the run's project.
- **Event and webhook triggers check the flow they fire:**
  - `read` to see one;
  - `write` to pause, resume or unregister it;
  - `write` plus `execute` to register it or change it.
- **Eval runs:** starting one needs `write` on its project and `execute` on what it evaluates. Reading one needs `read` on its suite; cancelling one needs `write` on it.
- **A thing that isn't there is still its route's `404`.**
- **Fix:** `POST /v1/event-triggers` reads `config.eventKind`. It read `config.config.eventKind`, so every registration answered `400`.
