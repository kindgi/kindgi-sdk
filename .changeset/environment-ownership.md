---
"@kindgi/api": patch
---

**A later environment of an environment order takes builds only by promotion.** Builds and new versions enter an order at its first environment; nothing reaches a later one except by promotion from the one before it. All of this applies only when the runtime wires `environmentOrders`. A project that's first in its order, or in no order, works as before.
- **`POST /v1/deployments`** into a later environment (position 1 or more) is refused with **`409 environment-takes-promotions`** before anything is written: deploy into the order's first environment and promote the build from there. With no project named, the tenant's default project is the one checked. `details.position` is always present; `details.firstProjectId` appears only when the caller can read that project.
- Publishing an agent, a flow, a tool, a guardrail or a data block through the API into a later environment is refused the same way. Such a version stays in the environment it was published in, because only builds move between environments. Eval suites aren't refused: they're test data, published in any environment and reached there and in the later ones.
- A derived agent version (**`POST /v1/agents/{agentId}/versions`**) that names a later environment is refused. Otherwise it's made in the first environment of the agent's project's order, and reaches the later ones when a build of the agent is promoted. The agent's project doesn't change. An improvement proposal's derived version and its edited data blocks are made in that first environment too, and the proposal's candidate is evaluated in the project it was made in.
- A deploy keeps a guardrail registered in another project of the target's order instead of refusing it with `guardrail-project-mismatch`.
- `AgentVersionRecord`, `FlowVersionRecord` and `EvalSuiteRecord` gain an optional `madeInProjectId`: the project a version was made in, when the store records it. It isn't on the wire.
- `ItemReference` gains an optional `version`: a reference to one version of an agent, flow or eval suite. `referencesOutOfScope` asks about each version once.
