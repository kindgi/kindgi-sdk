---
"@kindgi/types": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**Derive an agent version with new data-block pins, with no code change.** An expert edits a prompt or settings block and publishes a new version of it; deriving an agent version is how that edit reaches the agent.

- **`POST /v1/agents/{agentId}/versions`** `{ from, pins: { prompts?, settings? }, label?, projectId? }`:
  - The new version is `from` with the named pins swapped, everything else kept.
  - It's numbered the next free patch after the agent's highest version (versions never change).
  - It records `derivedFrom: { version, reason: 'edited', label?, by: 'user:<id>' }`.
  - Answers `201` with the new agent version.
  - Needs `publish` on the agent.
- **Refusals** (`400 validation-failed`, naming each problem under `details.issues`):
  - a version published before pins;
  - a block the version doesn't already reference (adding one is a code change);
  - a block version that isn't published, is unregistered, is the wrong kind, or isn't model settings for the model-settings block;
  - swaps that change nothing.
  - Tool pins can't be swapped: they come from code.
  - An unknown version answers `404 agent-not-found`.
- **Clients:**
  - TS: `client.agents.versions.derive(agentId, { from, pins, label })`.
  - Python: `client.agents.derive_version(agent_id, from_=..., pins=...)`.
  - CLI: `kindgi agents derive <agent-id> --from=<semver> --prompt=<block-id>=<version> --setting=<block-id>=<version> [--label=<text>]`. Repeat `--prompt` and `--setting` for several blocks.
- **Deploys:** a deploy whose definition and pins match a derived version reuses it, reporting the deploy's own reason (`pins-changed`), not `edited`.
- **`VersionDerivation`:** `reason` adds `'edited'`; new optional `label` and `by`.
