---
"@kindgi/tools": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**Unregister stops a version being chosen, not the pins that hold it.**

- **Retired tool versions.** `createToolRegistry().register(tool, { retired: true })` keeps an unregistered tool version for the published agent and flow versions that pin it.
  - Only its exact version (`getVersion`, `hasVersion`) reaches it.
  - `resolve` (a range), `get` (latest), `list`, `versions`, `has` and `ids` skip it.
- **A pinned turn reaches it.** A turn resolves a pinned tool by its exact version, so a published agent version pinned to a retired tool version keeps running it. A range never picks one.
- **`getVersion` reads unregistered versions.** `AgentRegistryBinding.getVersion` and `FlowRegistryBinding.getVersion` return them too (`AgentVersionRecord`, `FlowVersionRecord`, with `unregisteredAt`). `GET /v1/agents/:id/versions/:version` and `GET /v1/flows/:id/versions/:version` return `unregisteredAt`.
- **Who reads what:** a resumed run, provenance, and a flow version that pins an agent version read unregistered versions. A new run that names one is refused by the runtime.
