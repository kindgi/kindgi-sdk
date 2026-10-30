---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/tools": patch
---

**Latest moves only with a deploy or an add.** A run that names no version, in a scope no pin covers, gets the agent's Latest in its project, no longer its highest version. Latest moves only when a deployment into the project ships a version, or when a person publishes a full version (`POST /v1/agents`) or makes an existing one Latest (`AgentRegistryBinding.markLatest`). A derived version (`POST /v1/agents/{agentId}/versions`) is never Latest by itself: a run gets it only where a pin names it. A pin never moves Latest. A project where no version has a time yet has no Latest. The highest version still numbers the next one, and `GET /v1/agents/{agentId}` still answers it.

- `GET /v1/agents/{agentId}/projects` says, for each project, what a run there that names no version gets (`runs`: the version, since when, and the pin or deployment behind it) and why (`follows`: `pin` or `latest`), the pins on segments inside it (`segments`), and the agent's `highest` version. All new fields are optional. A version the caller can't see is left out.
- What serves a scope (`GET /v1/agents/{agentId}/live`), a promotion's check, an improvement pass and a flow publish's default agent pin all read Latest the same way: a covering pin, else Latest.
- `@kindgi/api`: a new `LatestBinding` (`AgentReleaseBindings.latest`, required) answers a project's Latest (`latest`) and every project's (`byProject`). `whatRuns(releases, q)` and `whatRunsByProject(releases, q, projectIds)` answer a pin, else Latest. `AgentPublishInput.madeFor` (required) says what a version is made for (`latest`, or `project` for a derived one), and `latestBy` records the person whose publish made it Latest. `AgentRegistryBinding.markLatest` (required) makes an existing version Latest in the project it was made in.
- `@kindgi/tools`: `latestVersion` is now `highestVersion`, since it answers the highest version, which isn't always what a project runs.
