---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/tools": patch
"@kindgi/handler-runtime": patch
"@kindgi/specs": patch
"@kindgi/client": patch
---

**An agent's prompt and settings can come from data blocks, pinned when the agent version is published.**

- **References:**
  - `instructions` is the system prompt, or a prompt block by range: `{ prompt: 'acme.intake-prompt', version: '^1.0.0' }`. Its template and declared parameters are used instead.
  - `settings: [{ id, version }]` lists settings blocks.
  - `modelSettings: { id, version }` names a model-settings block (`MODEL_SETTINGS_SCHEMA`: `temperature`, `maxOutputTokens`).
- **Pinned at publish:** `POST /v1/agents` and deploys resolve each reference by `pickVersion` into `pins.prompts` / `pins.settings`, alongside the tools.
- **Refusals:** a reference that matches no published version, names a block of the other kind, names model settings that aren't, or runs on a runtime with no block registry refuses the publish (`400 validation-failed`).
- **At run time:** a turn loads each block at its pinned version. A resumed turn uses the versions its `setup` journaled (`blockVersions`).
  - The prompt block renders as the instructions.
  - Settings values reach tools as `ToolContext.settings['<id>']` and templates as `settings["<id>"]`.
  - Model settings go into the model call.
  - A block that can't load fails the turn (`block-unresolvable`).
  - `InvokeAgentBindings` takes an optional `blockReader`.
- **Changed elsewhere:** the agent spec, the pack index, both indexers (TS and Python: `Agent(instructions={...}, settings=[...], model_settings={...})`), and both clients.
- **Pack protocol 2.4.0:** `callContext` gets optional `settings`, so pack code reads them: `ctx.settings['acme.weights']` in TS, `ctx.settings["acme.weights"]` in Python. Older pack services still answer calls that carry it: a TS one passes it to the handler, a Python one drops it.
- **`settings` is now a reserved template name.**
