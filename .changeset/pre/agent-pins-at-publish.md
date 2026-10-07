---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**An agent version is pinned when it's published.** `POST /v1/agents` resolves each of the agent's tool ranges once, to the highest active version the range allows (`pickVersion`). It stores the result on the version as `pins` (`{tools, prompts, settings}`: tool id → exact version) with `pinsDigest` (`sha256:<hex>` of the pins' canonical JSON). Every run of that version uses exactly those tool versions. A new tool version reaches the agent only through a new agent version, and two runs of one agent version always run the same tools.

- **A range that matches no published version refuses the publish:** `400 validation-failed`, with one issue per tool (`/tools/<i>/version`, "publish the tool first").
- **Pins are set by the runtime, never authored.** `defineAgent` doesn't take them, and a publish body's `pins` is ignored.
- **`GET /v1/agents/:id/versions/:version` returns `pins` and `pinsDigest`**, as do both clients. Python adds `pins_digest()` in `kindgi.client`, which gives the same string as `pinsDigest()` in `@kindgi/agents`.
- **Unchanged:** a version published before pins, or by a runtime without a tool registry, has no pins and resolves its ranges per run. `agentsRouter` takes the tool binding as an optional third argument, and `createApp` passes its `toolRegistry`.
