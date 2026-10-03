---
"@kindgi/agents": minor
"@kindgi/specs": minor
"@kindgi/handler-runtime": patch
"@kindgi/dev-echo-provider": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

Typed agent output and structured turn input.

- `@kindgi/agents`:
  - **Typed output.** An agent can declare `output: { schema, name?, maxRepairs? }` (JSON Schema, or a Zod schema converted by `defineAgent`).
    - The final answer must be JSON matching the schema; a fenced JSON block is accepted.
    - An answer that doesn't fit is sent back to the model with the problems listed, up to `maxRepairs` times (default 1, counted against `budget.maxSteps`). After that the turn fails with `output-schema-violation` (`errors`, `attempts`).
    - The parsed answer is `AgentTurnResult.output`, or `null` on a dry run, where no answer is checked.
  - `AgentTurnResult.runId` is the turn's kernel run.
  - **Structured input.** `invokeAgent({ input })` makes `{{ input.* }}` available to the instructions (`input` joins `AUTO_INJECTED_VARS`). It is kept in the run snapshot and passed to guardrails as `trace.attributes.stepInput`.
  - **Parent link.** `invokeAgent({ parent })` records the run that started the turn, for turns started by a flow step.
  - **Resume.** The run snapshot keeps `parameters` and `input`, and `resumeAgentTurn` restores them; a resumed turn used to lose its parameters. Migration `0002` adds the two columns to `agent_run_snapshots`.
  - **Guardrail trace.** `buildRunTrace` now takes the run id, project id, turn number and user message. The trace carries them, so failed checks during a turn produce compliance evidence. Before, `runId` was the conversation id, `turnCount` was the step count, and `projectId` was missing. `attributes.steps` replaces `attributes.turnCount`; a typed answer appears as `attributes.structuredOutput`.
  - `defineAgent` keeps `preferredModel`.
- `@kindgi/specs`: `agent.schema.json` schema-version 1.2.0 adds `output`, `preferredProvider` and `preferredModel`.
- `@kindgi/handler-runtime`: the indexer carries an agent's `output`, `conversationPolicy`, `preferredModel`, `description` and `tags`.
- `@kindgi/dev-echo-provider`: a call with no tools gets the last user message back as the answer, instead of a call to an echo tool the agent doesn't have.
- `@kindgi/api`: the `Agent` and `PublishAgentBody` schemas accept `output` (`AgentOutputSpec`); `output-schema-violation` maps to 422.
- `@kindgi/client`: the generated agent types carry `output`.
