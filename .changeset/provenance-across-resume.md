---
"@kindgi/agents": patch
---

An agent turn's provenance is whole, whether or not it parked.

- **A turn resumed after a tool-call approval** keeps the nodes of the steps that ran before the park: its user message, its retrievals, each model call, and the tool calls of each completed step. Before, they were lost, and the resumed turn's edges pointed at nodes that weren't there.
- **Every tool call has its `tool-call` and `tool-result` nodes:** one that ran, one a reviewer rejected, one that failed, and one that ran before a park in the same step.
- **Each model call is `influenced-by` the tool results it read:** every result of the turn before it. The answer now links the tool output it came from.
