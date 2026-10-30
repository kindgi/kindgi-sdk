---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**An agent's owner.** `PUT /v1/agents/{agentId}/owner` with `{ "userId": "…" }` (`client.agents.setOwner(agentId, userId)`, `kindgi agents owner <agent-id> --set=<user-id>`) names the person who owns an agent. Setting it again replaces it. It takes admin on the agent. `GET /v1/agents/{agentId}` (and `kindgi agents owner <agent-id>`) answers `owner: { userId, name }`, where `name` is the person's display name when they have one. An agent no one has set an owner for has no `owner` field.

- When the server knows the tenant's people, a user it doesn't have, or one who has left, is `404 identity-user-not-found` and nothing is set.
- An agent no one registered is `404 agent-not-found`.
- An agent store that doesn't keep an owner answers `501 agent-owner-unsupported`. `AgentRegistryBinding.setOwner` is optional, and a store that implements it answers the owner on `get` as `AgentVersionRecord.owner`.
