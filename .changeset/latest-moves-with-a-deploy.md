---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/tools": patch
---

**Latest moves only with a deploy or a person's publish.** A run that names no version, in a scope no pin covers, gets the agent's Latest in its project, no longer its highest version. Latest moves only when a deployment into the project ships a version, or when a person publishes a full version (`POST /v1/agents`) or makes an existing one Latest (`AgentRegistryBinding.markLatest`). A derived version (`POST /v1/agents/{agentId}/versions`) is never Latest by itself: a run gets it only where a pin names it. A pin never moves Latest. A project where no version has a time yet has no Latest. The highest version still numbers the next one, and `GET /v1/agents/{agentId}` still answers it.

- `GET /v1/agents/{agentId}/projects` says, for each project, what a run there that names no version gets (`runs`: the version, since when, and the pin or deployment behind it) and why (`follows`: `pin` or `latest`), the pins on segments inside it (`segments`), and the agent's `highest` version. All new fields are optional. A version the caller can't see is left out.
- What serves a scope (`GET /v1/agents/{agentId}/live`), a promotion's check, an improvement pass, a flow publish's default agent pin and a trigger's `toolsAllowedUnattended` check (for an agent that names no version, in the trigger's project) all read Latest the same way: a covering pin, else Latest.
- A promotion into a scope where no version of the agent runs yet (no pin, and no Latest) is refused with `409 nothing-runs-in-scope`, or `409 project-suspended` when the scope's project is suspended, since there's nothing to measure it against. It's no longer measured against the highest version. The TypeScript client throws `ConflictError` for the new code. An improvement pass with no `fromVersion` where nothing runs answers `404 agent-version-not-found`, saying so.
- `@kindgi/api`: a new `LatestBinding` (`AgentReleaseBindings.latest`, required) answers a project's Latest (`latest`) and every project's (`byProject`). `whatRuns(releases, q)` and `whatRunsByProject(releases, q, projectIds)` answer a pin, else Latest. `AgentPublishInput.madeFor` (required) says what a version is made for (`latest`, or `project` for a derived one), and `latestBy` records the person whose publish made it Latest. `AgentRegistryBinding.markLatest` (required) makes an existing version Latest in the project it was made in.
- `@kindgi/tools`: `latestVersion` is now `highestVersion`, since it answers the highest version, which isn't always what a project runs.
