---
"@kindgi/cli": patch
"@kindgi/client": patch
---

`kindgi tools publish --manifest=<json-or-@file> [--project=<project-id>]` registers a tool manifest (the tool minus its handler, which the runtime must already have) at its version, in the tenant's Default project or the one named. Before, it failed with "not yet wired". The TypeScript client gains `client.tools.register(manifest, { projectId })` (`POST /v1/tools`), as the Python client has.
