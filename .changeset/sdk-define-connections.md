---
"@kindgi/sdk": patch
---

**`@kindgi/sdk/define` re-exports a tool's connection names** from `@kindgi/tools`, unchanged: `ConnectionRejectedError` and `isConnectionRejectedError`, and the types `ToolConnection`, `ConnectionNeed` and `ConnectionAccount`. A tool that declares `needsSpec.connections` imports everything from the SDK, as for its other names.
