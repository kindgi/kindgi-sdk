---
"@kindgi/platform": patch
"@kindgi/api": patch
"@kindgi/authz": patch
"@kindgi/agents": patch
"@kindgi/memory": patch
"@kindgi/env-schema": patch
"@kindgi/client": patch
"@kindgi/testing": patch
---

**A person's own test project.** Anyone in the workspace can make one test project of their own: `POST /v1/projects` (`client.projects.create`) takes an optional `testFor`, their own user id, and the project carries it. It's set only when the project is made, so `PATCH /v1/projects/{projectId}` refuses it with `400 bad-input`. A test project follows these rules:

- **One per person per workspace.** A second is `409 project-test-already-exists`. `ProjectCreateOutcome` gains that kind, `CreateProjectError` gains `test-conflict`, and the project binding conformance suite checks it.
- **Only its person makes it.** Any member may, without admin on the workspace, but `testFor` must be their own user id. Someone else's id, or a key limited to a project, gets `403 project-test-not-yours`. It's refused together with `orgId` or `isDefault` (`400 bad-input`).
- **Only an isolated runtime holds them** (`KINDGI_TENANT_HOST_ACCESS=isolated`). On any other runtime, the create gets `409 project-test-needs-isolated-runtime`.
- **Only where the store keeps them.** `ProjectBinding` and `TenantHierarchyBinding` gain an optional `keepsTestProjects: true`, which the in-memory project binding sets. The store that makes the project (the hierarchy binding with an authorizer, else the project binding) needs it. Without it, `testFor` gets `501 project-test-unsupported`, and making any project takes admin. `StubMethods` lists a binding's methods only, so a stub leaves the marker out.
- **Its person is its `admin`, never its owner.** `tuplesForCreate` writes `admin` for `testFor`, whoever creates it.
- **Nobody else is in it, and it stays a test project.** Each of these gets `409 project-is-a-test-project`, with `details.projectId`: adding a member or a team, changing or removing its person, moving it into an org, putting it in production, naming it in an environment order, and setting its repo connection. Taking it out of production is answered as for any project.
- **Its person writes its secrets** without `secrets:write`.
- **What's made elsewhere stays out.**
  - A key or session limited to a test project reads only the facts in it. `MemoryReaders.projectFactsOnly` leaves out every fact with no project, and every conversation with none: `isReadableBy` and `isRecallReadableBy` honour it.
  - A run whose `InvokeAgentInput.projectIsTest` is set recalls only the facts in its project: the turn's retrieval passes it on (`RetrievalRun.projectIsTest`), and `runMemoryReaders` sets `projectFactsOnly`. It doesn't remember a fact for the whole workspace (`scope: 'tenant'`).
