---
"@kindgi/agents": patch
---

A failed model call says why. The turn's `model-invocation-failed` message names the provider and model and carries the provider's own words — `Model call to anthropic (claude-haiku-4-5) failed: 401 … "API key is invalid."` — instead of only `Model call step "invoke" failed` (the detail was in `cause`, which callers don't show). The cause text is one line, at most 500 characters.
