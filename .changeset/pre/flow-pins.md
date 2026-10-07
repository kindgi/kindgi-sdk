---
"@kindgi/flow": patch
"@kindgi/agents": patch
"@kindgi/types": patch
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**A flow version is pinned when it's published, as an agent version is.** `POST /v1/flows` pins each tool the flow runs to its latest active version: tool nodes, fanout branches, and nodes in loop bodies. It also pins each agent the flow runs at no named version (an agent node without `config.version`). The result is stored on the version as `pins` (`{tools, agents}`) with `pinsDigest`, and every run of that flow version uses those versions. A new tool or agent version reaches the flow only through a new flow version. An agent node with its own `config.version` keeps it.

- **Refusals:** a tool or agent with no published version refuses the publish (`400 validation-failed`, naming each).
- **Deploys** pin flows after agents and follow the same rule as agents, from one shared code path. When pins change, the deploy registers the next free version with `derivedFrom`, and a redeploy is idempotent. So one tool change cascades through an agent into a flow within a single deploy, each derived once. The deployment's `contents.flows` names each flow's registered version (`DeployedVersion`), and `kindgi deploy` prints one line per renumbered flow.
- **Unchanged:** a flow version published before pins binds the latest versions per run, as before.
- **New exports:**
  - `@kindgi/flow`: `FlowPins`, `flowPinsDigest()` and `flowRefs()`.
  - `@kindgi/types`: `VersionDerivation`.
  - `@kindgi/agents`: `PinChange.kind` adds `agent`, and `pinChanges()` takes any pin set. `withVersions(flow, { tools?, agents? })` (`@kindgi/flow`) runs a flow version with some blocks at other exact versions through the same pins: what a comparison or replay runs, with `pinsDigest` recomputed.
