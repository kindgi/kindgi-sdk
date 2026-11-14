---
"@kindgi/agents": patch
---

An agent turn's provenance now names the agent on every node of its own acts, as `agent:<id>@<version>`, the form a `memory-write` node already had: its model calls, the tool calls they make, its answer (`model-output`), and the `wait` of an approval it waits for, on a tool call or for the session. Before, a model call, a tool call and the answer had no `actor`, and an approval's wait named the agent as `agent:<id>`, without its version. A session approval's `resume` names who decided, as a tool call's does. When the decision doesn't say, or the wait was cancelled, it names no one, where it named the agent as `agent:<id>` before. A `tool-result` still has no `actor`. Records written before keep what they have.
