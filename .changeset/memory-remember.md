---
"@kindgi/memory": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/specs": patch
"@kindgi/client": patch
---

Agents can remember, under rules the model can't change.

- **The declaration.** `defineAgent({ memory: { remember: { types: ['preference'], scope: 'same-user', keepDays: 30 } } })` gives the agent's turns the built-in tool `kindgi.memory.remember`. The model picks the type (one of `types`), the text (up to 2,000 characters), an optional slot `key` and when it stops being true. It never picks the scope: `same-user` (the conversation's end user, else the user the run acts for), `same-conversation`, `same-project` or `tenant` come from the declaration and the run. The tool id is reserved: an agent can't list it in `tools`.
- **Every remembered fact** is `unverified`, attributed to the agent version (`attributedTo`) and to the run, step and tool call that wrote it (`generatedBy`). It expires after `keepDays` (default 30) unless a person verifies it. A new value for the same type and `key` replaces the one the same agent remembered before, as that fact's next revision. An agent never replaces another agent's fact or a person's.
- **A person approves it first** when the scope is wider than one person (`same-project`, `tenant`), or the text reads like an instruction (always/never, ignore/disregard, "you must", a link, one of the agent's tools). Until then no read sees it, and the model is told it waits for review. Otherwise it's used at once.
- **The tool dispatches like any other.** The agent's `hitl.tools` policy applies to it, a replay refuses it or uses the recording, and the tool error policy decides what a failed store does. `InvokeAgentBindings.memoryWriter` (`MemoryRememberBinding` in `@kindgi/memory`) is where the runtime stores it. On a host without one, a call answers that nothing was remembered, and publishing warns `remember-unavailable` (`MemoryBinding.agentRemember`).
- **The `<memory>` block** now gives each fact the time it was recorded (`recordedAt`), and for a fact an agent remembered, which agent (`agent`). Two agents' values for the same slot both show, each with its agent and time; none is picked silently. **This changes what models see.**
- **Provenance.**
  - Each retrieval intent is a `memory-read` node with `operation: search_memory`, holding what it searched and the ids it found. Each retrieved fact is `retrieved-from` its search and carries its ranks.
  - Each remembered fact is a `memory-write` node with `operation: create_memory` or `update_memory`, its actor the agent version, `produced` by the tool call.
  - These are the OpenTelemetry GenAI operation names, as an attribute on the existing node kinds, so no client sees a new enum value.
- **`Fact.expiresAt`** (optional in the API): when a revision stops being readable. No read returns a fact after it. The runtime sets it from the fact's retention, or from an agent-remembered fact's unverified window.
- **Specs.** The agent spec (schema-version 1.5.0) carries `memory.remember`. The pack index keeps it, as it keeps all of `memory`.
