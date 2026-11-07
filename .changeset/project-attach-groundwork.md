---
"@kindgi/api": patch
"@kindgi/env-schema": patch
"@kindgi/client": patch
---

**Groundwork for a project's attaches.** An attach sends the runs a person starts with a key of theirs, limited to one project, to their working copy of the project's code before it's deployed. This adds what a runtime builds them on:

- **`system:attaches`**, a system scope for writing a project's attaches. Only a key holding it itself uses it (`ownSystemScope`, which the package exports): `kindgi:system` doesn't stand in. No key holds it on a runtime serving one tenant, with or without a pack service per deployment.
- **The key a run came with.** `POST /v1/runs` passes the calling key's id to the run handler as `callerTokenId`, on `InvokeAgentBindingInput` and `InvokeFlowBindingInput`: an API key's, a person's or a service account's, and none for a sign-in session. The body never sets it.
- **`checkPackIndex`**: the deploy route's checks of a pack's `index.json`, on their own and exported, so a runtime checks a copy of an index as a deploy would. A deploy accepts and refuses the same indexes as it did.
- **Error codes:** `attach-ended` (409), which the TypeScript, Python and Java clients list as a conflict; `attach-not-found` (404); `attach-needs-project-admin`, `attach-project-in-production`, `attach-key-not-limited-to-project`, `attach-test-project-not-theirs` and `attach-route-host-not-allowed` (409); and `attach-index-invalid` (400), `attach-index-too-large` (413) and `attach-index-too-soon` (429). The errors reference has each.
- **`KINDGI_ATTACH_ROUTE_HOSTS`** (env-schema): the hosts an attach's route may be on, with `parseAttachRouteHosts` and `ATTACH_ROUTE_HOSTS_VAR`. It's written as `KINDGI_PACK_ENDPOINT_HOSTS` is, and its errors name it.
