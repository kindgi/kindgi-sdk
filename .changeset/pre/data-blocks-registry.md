---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**Data blocks: versioned prompts and settings an agent version will pin.** A block is published like a tool: immutable versions, soft unregister and reinstate. It belongs to one project.

- **Kinds:**
  - `prompt`: a Liquid template with declared parameters, rendered as an agent's instructions are.
  - `settings`: a JSON object, optionally with a JSON Schema. Its values must satisfy it, and so must a later version's.
- **`@kindgi/api` adds `/v1/blocks`:** list (latest of each; `kind`, `name`, `projectId` filters), get, versions (`includeTombstoned`), a version, publish, unregister and reinstate. It's mounted when `createApp` gets a `blockRegistry` (`BlockRegistryBinding`).
- **Authorization goes through the block's project:** `read` to read, `write` to publish, unregister or reinstate. A block the caller can't read answers 404.
- **Refusals:**
  - a block's kind never changes;
  - a block's versions stay in its first version's project (`409 block-project-mismatch`);
  - a taken version is `409 block-already-registered`.
- **`@kindgi/agents` adds** `validateBlock()`, `settingsSchemaIssues()` and the block types.
- **Clients:** `@kindgi/client` adds `client.blocks`, and the Python client has the same resource.
- **`@kindgi/cli` adds** `kindgi blocks list | show | versions | publish | unregister | reinstate`. `publish` takes `--prompt=@<file>`, `--settings=<json>|@<file>` with `--schema`, or a full definition as JSON.
