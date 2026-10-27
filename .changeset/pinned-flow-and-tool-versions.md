---
"@kindgi/api": patch
"@kindgi/authz": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/compliance": patch
"@kindgi/runtime": patch
"@kindgi/sdk": patch
"@kindgi/specs": patch
"@kindgi/types": patch
---

**Flows and tools can have pinned versions, as agents have live versions.** A pin says which version is in use in a scope (a project, an org or the tenant) when nothing names one. A new version is then published without going into use where a pin covers. Without a pin, a new version is in use at once, as before.
- `@kindgi/api` adds `PinnedVersionBinding`, the binding behind the pins, and `createApp({ pinnedVersions })` to wire it. Its `resolve` takes the most specific pin covering a project (the project, its org, then the tenant) whose version is still active. `list`, `pin`, `unpin` and `history` keep each change for good: what was pinned before and after, who asked and why.
- The pin routes check, in order: the right to pin, the scope (a segment is `400 scope-invalid`, since flows and tools pin no finer than a project), the item and its version, that a project scope reaches the item, and that a pin wider than one project isn't for an item in an environment order (`409 pin-scope-spans-environments`). A tool pin is also refused on a later environment of an order (`409 environment-takes-promotions`), since a tool's pin acts where agent and flow versions are made. A tool that follows its server, an MCP catalog's or one the runtime ships, can't be pinned (`400 tool-not-pinnable`).
- Flows: with the binding, `/v1/flows/{flowId}` gains the five pin routes (`flows.pinned.resolve`, `list`, `pin`, `unpin` and `history`). A run that names no flow version takes the version pinned for its project, else the newest the project reaches, and `GET …/pinned` answers what such a run takes there; a pin whose version doesn't reach the project is passed over, as a run passes it over. Under `kindgi dev`, the flow registry is read-only and a pin write is refused with `409 registry-read-only`, as its other writes are. `Run` gains the optional `flowVersionVia` (`explicit`, `pinned` or `latest`) and `flowPinnedScope`, and `StartRunBody.flowVersion` says that an omitted version takes the pin.
- Tools: with the binding, `/v1/tools/{toolId}` gains the same five routes (`tools.pinned.*`). An agent or flow version made in a project a tool's pin covers (`POST /v1/agents`, `POST /v1/flows`, a deploy) locks the tool at the pinned version: a flow's tool step always, an agent's tool range when the pinned version is in it; else as before. A deploy looks each tool's pin up once. `GET …/pinned` answers what a flow version made there would lock. A tool an MCP catalog lists (its `kindgi.mcp` metadata) is refused with `400 tool-not-pinnable`, and a pin on a later environment of an order with `409 environment-takes-promotions`.
- A deployment promotion with `makeLive` also pins each flow version it carries for the target project, after the agents, and its answer lists them in the new optional `pinnedFlows` (`DeploymentPinnedFlow`: `{id, version}`). The right to pin each flow is checked with the agents' rights, before any pin. An error after some pins lists the flows pinned so far in `error.details.pinnedFlows`, as `error.details.live` lists the agents. Without the binding, nothing pins a flow and the answer has no `pinnedFlows`.
- Unregistering a pinned flow or tool version answers `409 flow-version-pinned` or `409 tool-version-pinned`, naming the pins' scopes in `details.scopes`: `FlowUnregisterOutcome` and `ToolUnregisterOutcome` gain the optional `pinned`, which a registry that knows pins sets.
- New schemas: `PinScope`, `PinActor`, `PinnedVersionResolution`, `PinnedVersion`, `PinnedVersionList`, `PinnedVersionChange`, `PinnedVersionChangePage`, `PinVersionBody` and `UnpinVersionBody`. New error codes: `pin-scope-spans-environments`, `tool-not-pinnable`, and `flow-version-pinned` and `tool-version-pinned`, which a runtime answers when a pinned version is unregistered or its item deleted.
- `@kindgi/authz` adds the `pin` action (`can_pin`) on flows and tools, so a caller's permissions can list it there.
- `@kindgi/compliance` and `@kindgi/specs` add six audit kinds: `flow-pinned`, `flow-unpinned`, `flow-pin-inactive`, `tool-pinned`, `tool-unpinned` and `tool-pin-inactive`.
- `@kindgi/types` adds `PinScope`, `PinnedItemKind` and `FlowVersionVia`.
- `@kindgi/runtime`: `RunFlowInput`, `StartRunParams` and `KernelRunRecord` gain the optional `flowVersionVia` and `flowPinnedScope`, recorded with the run.
- `@kindgi/cli`: `kindgi promote --make-live` also prints each flow version it pinned in `--to`, under "Flows pinned in", and its help says so; with `--json` they are in `promotion.pinnedFlows`.
- `@kindgi/client`: `client.flows.pinned.{resolve, list, pin, unpin, history}`, the same on `client.tools.pinned`, `Run.flowVersionVia` and `Run.flowPinnedScope`, and `DeploymentPromotion.pinnedFlows`.
- `@kindgi/sdk`: the four flow skills (`kindgi-authoring-flows` and its Java, Python and Scala ones) say a run keeps the flow version it started on, and that a run naming no version takes the version pinned for its project (or its org, or the tenant), else the newest the project reaches.
