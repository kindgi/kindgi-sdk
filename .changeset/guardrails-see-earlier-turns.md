---
"@kindgi/agents": patch
"@kindgi/guardrails": patch
"@kindgi/sdk": patch
---

**A guardrail with `sees: 'conversation'` gets the conversation's earlier turns.** Its check reads them in `trace.earlier`, which the agent turn never filled until now: the turns the model was given for this turn, oldest first, all of them or the agent's `conversationPolicy.historyLimit` window. Each is a `TraceTurn`, in the trace's own field names: `userInput`, its `toolCalls` and `toolResults`, and its answer, `output`. A turn the history limit cut short has no `userInput`, and a conversation's first turn gives `[]`. The guardrail gets them at the final answer and at the loop's points, and a pack's check gets them over `check-invoke` with the rest of the trace.

- **Only the guardrail that asks gets them.** `evaluateGuardrail` gives `earlier` to a guardrail with `sees: 'conversation'` and leaves it out for the others, so its check, its judge and its action read the same trace. A turn none of whose guardrails asks doesn't read its history for them.
- **The history is read once per turn.** The turn keeps what it gave its model, and its checks read that. A turn resumed in another process reads it again, once: the same window, since it ends before the turn's own message.
- **An llm-judge that sees the conversation is shown it.** Its prompt adds the earlier turns, each one's user message, tool calls and answer, and then this turn's user message, before the run's output. The tools' results stay out, as for this turn. A judge that sees the turn gets the prompt it got before.
- `buildRunTrace` (`@kindgi/agents`) takes the earlier messages, as stored, in an optional `earlier`, and gives the trace their turns.
- **Docs.** "Write a guardrail" shows a check that every figure in an answer comes from the conversation, and says what a judge is shown; the guardrails overview and the guardrails authoring skill say a check sees one turn unless its guardrail asks for the conversation.
