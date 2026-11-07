---
"@kindgi/sdk": patch
---

**The agents authoring skills say that `retryOn` replaces the default kinds.** The TypeScript, Java, Python and Scala skills tell an agent to add `tool-error` to `retryOn` when retrying a tool that ran and failed is safe. They now also say the list replaces the default, so it keeps `invalid-arguments` and `unknown-tool`: a `retryOn` of `tool-error` alone no longer sends a call with bad arguments, or to a tool that doesn't exist, back to the model. The Wait for another system's answer guide, on a wait that times out, says it too.
