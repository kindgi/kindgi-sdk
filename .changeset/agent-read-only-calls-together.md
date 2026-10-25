---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/handler-runtime": patch
"@kindgi/specs": patch
"@kindgi/tools": patch
"@kindgi/sdk": patch
---

**A model step's calls to read-only tools that come one after another run at the same time, up to 8 at once.** A turn used to run a step's tool calls one after another. Now each batch of up to 8 consecutive calls to tools that declare `mutating: false` (and no changing effect) starts together, and a call to any other tool runs on its own, in the order the model asked. A call that may wait, for another system's answer (a tool that pauses) or for the person who started the run to connect an app (a tool that declares connections), runs on its own too. The results reach the conversation and the model in that order, and the `tool.started` and `tool.completed` events keep it too; each call's `durationMs` is its own. Each batch is planned just before it starts, so a call's access is checked when it's about to run, not when the step began. Once a call needs a review (a tool gate, or a call that waits for a person's approval in an unattended run), the step's calls that haven't started run one at a time, as before, and each is checked again when it runs. When one call of a batch throws, the others are stopped through the step's abort signal and the turn fails after they've settled. A replay answers recorded calls from the record and runs the live ones together the same way. Tool retries (`toolErrors`) count failures in the model's order.

A new optional agent field, **`parallelToolCalls`** (default on), turns it off: `false` runs every call on its own, as before. It is in `agent.schema.json` (1.7.0) and `pack-index.schema.json` (1.7.0), `AgentSpec` and `defineAgent` (which refuses a value that isn't `true` or `false`), the indexed pack agent, `POST /v1/agents`, `GET /v1/agents/...` and a deployment's agents (`agent.parallelToolCalls must be true or false` at `/parallelToolCalls`), and the Python SDK's `Agent(parallel_tool_calls=...)`. The `mutating` field's description, in `tool.schema.json`, `ToolSpec` and the API's `ToolSpec` schema, now says it decides what runs together. The authoring skills for tools and agents (TypeScript, Python, Java and Scala) say so too.
