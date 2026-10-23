---
"@kindgi/sdk": patch
---

**The tool-authoring skill covers connections to other apps.** A tool declares the connection it needs in `needsSpec.connections`, reads the call's short-lived token from `ctx.connections`, and throws `ConnectionRejectedError` with the connection's name when the app answers 401.
