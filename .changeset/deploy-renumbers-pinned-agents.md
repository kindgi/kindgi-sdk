---
"@kindgi/api": patch
"@kindgi/agents": patch
"@kindgi/tools": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**A deploy pins its agents and never keeps a version's old pins.** `POST /v1/deployments` pins each agent as `POST /v1/agents` does. A deploy registers an agent under the version its definition names. When that version is already registered with other pins or content (versions never change), the deploy registers the next free version in its line instead (`1.4.0` → `1.4.1`, `1.4.0-rc.1` → `1.4.0-rc.2`). A deploy never refuses a routine deploy over this.

- **Why a new version:**
  - `pins-changed`: a tool the agent uses has a new version in range.
  - `unpinned`: the version was published before pins existed.
  - `version-taken`: the number is registered with another definition.
- **Redeploys are idempotent.** A redeploy finds the version an earlier deploy registered for the same definition and pins.
- **The record:**
  - The registered version records `derivedFrom: {version, reason}`.
  - The deployment's `contents.agents` names each agent's registered `version`. Where it differs from the definition's, it also gives `authoredVersion`, `reason`, `newVersion` and `pinChanges`.
- **`kindgi deploy` prints one line per such agent:** `agent acme.matcher: registered new version 1.4.1 (1.4.0's pins changed: tool acme.score 1.0.0 → 1.1.0); set version: '1.4.1' in acme.matcher to match`.
- **A range that matches no published version refuses the deploy:** `400 validation-failed`, with one issue per tool (`/agents/<i>/tools/<j>/version`), and the deploy's tools are rolled back.
- **New exports:**
  - `@kindgi/agents`: `pinChanges()` and the `AgentDerivation` and `PinChange` types.
  - `@kindgi/tools`: `nextVersion()`.
