---
"@kindgi/api": minor
"@kindgi/client": minor
---

A tool reads back the way it was registered: the wire shape carries the whole manifest.

- **`@kindgi/api`:**
  - `GET /v1/tools`, `GET /v1/tools/{toolId}` and the versions routes now return `mutating`, `sandbox`, `limits`, `network`, `needsSpec`, `codeArtifactRef` (where the code runs: the deployed image and module) and the declarative `spec`. Before, they dropped them, so nothing reading the API could see where a pack tool's code runs or how it's sandboxed. A secret appears only as a reference (`secretRef`), never a value.
  - The `Tool` schema (and `RegisterToolBody`, `ToolVersionRow`) declares those fields. They were accepted and stored already, but undocumented, so a typed client couldn't send them without a cast.
  - New components: `SandboxMode`, `RuntimeLimits`, `NetworkPolicy`, `TypedNeeds`, `CodeArtifactRef`, `ToolSpec`, and the declarative HTTP tool's `HttpToolSpec`, `HttpHeaderSpec`, `HttpAuthSpec`, `HttpRequestBodySpec`, `ToolSecretRef`. Each is a mirror of `@kindgi/specs/tool.schema.json`. The schema drift test now holds Tool's property names, and each of these, equal to the spec.
- **`@kindgi/client`:** the tool types gain the fields. The Python client's models follow.
