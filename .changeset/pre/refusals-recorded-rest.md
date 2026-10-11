---
"@kindgi/api": patch
---

**Every refusal of a caller the API knows is in the access audit.** Five more refusals were answered without being recorded. They're now recorded with the authorizer, so `GET /v1/audit/authz` shows them:
- **`key-project-mismatch`:** a request from a key limited to one project that names another, and a key limited to a project minting one that isn't.
- **`permission-denied`:** minting a key with capabilities you don't hold.
- **`judge-class-not-allowed`:** judging as a restricted judge class you may not assert.
- **`host-access-denied`:** registering a stdio MCP endpoint where the deployment runs no commands.

Each keeps its code and message, and its error gains the `action`, `resource` and `reason` details the other refusals carry. `key-project-mismatch` keeps its `keyProjectId` and `projectId`.

Four 403s stay out of the audit, because they don't refuse the caller:
- `signer-not-trusted`, which refuses an artifact;
- `csrf-origin-mismatch`, where the request may not be the principal's;
- a request with no principal: a public run token used outside its two progress routes, since it names a run, not a principal, and judging without a user or a service token;
- `role-exceeds-principal`, a limit on the key being minted.

A 401 (an unknown caller) never is in the audit.
