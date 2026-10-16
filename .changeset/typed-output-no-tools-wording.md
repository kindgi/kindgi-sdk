---
"@kindgi/agents": patch
---

**A typed agent the model is offered no tools for is no longer told to call tools first.** A typed agent's system message ended "Call the tools you need first; then give your final answer as that JSON alone." even when the turn offered the model no tools (no `tools`, and no `remember` from its memory). With no tools it now ends "Give your final answer as that JSON alone."; with any, it's unchanged.
