---
"@kindgi/agents": patch
---

A typed agent is told its `output` from the turn's first model call: the system message ends with the output's name and JSON Schema (descriptions included), in the words a repair repeats, and tells the model to call the tools it needs first. The first answer can fit, so a repair is the fallback, not most turns' second model call.
