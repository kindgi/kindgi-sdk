---
"@kindgi/agents": patch
---

**A turn that fails because a pinned tool version is gone says so once.** The `tool-version-unresolvable` message no longer repeats the registry's own "Tool "…" has no version "…" registered" after its explanation. It reads: `Tool "acme.lookup": this turn started with version 1.0.0, which is no longer registered; it doesn't run another version mid-turn.` The same goes for a version an agent version pins. When the tool has no version registered at all, the message still adds that.
