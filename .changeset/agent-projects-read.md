---
"@kindgi/api": patch
"@kindgi/client": patch
---

**Which projects an agent runs in.** `GET /v1/agents/{agentId}/projects` (`client.agents.projects(agentId)`) answers `{ data: [{ projectId }] }`: the project the agent was first published in, then each project a deployment that isn't retired shipped a version of it into, such as the next environment `kindgi promote` carried its build to. A change to the agent reaches each of them. Only the projects the caller can read are named, the first one included. It takes read on the agent, as `GET /v1/agents/{agentId}` does, a retired agent still answers, and an agent no one registered is `404 agent-not-found`. Without environment orders, an agent has one project. Under `kindgi dev`, whose pack names no project, the list is empty.
