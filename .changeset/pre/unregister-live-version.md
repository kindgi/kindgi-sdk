---
"@kindgi/api": patch
"@kindgi/client": patch
---

Unregistering an agent version that's live in a scope is refused with `409 agent-version-live`. The error's `details.scopes` lists the scopes it serves; roll back, unpin, or promote another version there first. Unregister stops a version being chosen, and a live pin is a standing choice, so the pin moves first and a scope never drops to the one above without anyone deciding it. `AgentUnregisterOutcome` gains an optional `live` (the scopes), which a runtime's registry sets; a registry that knows no live versions answers as before. The TypeScript and Python clients read the code as a conflict.
