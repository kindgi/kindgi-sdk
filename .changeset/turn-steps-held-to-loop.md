---
"@kindgi/agents": patch
"@kindgi/specs": patch
"@kindgi/sdk": patch
---

**A turn whose `maxSteps` is above 32 now stops at the 32nd model call with `budget-exceeded`, instead of running its loop out.** A turn's loop runs at most 32 iterations (`AGENT_TURN_LOOP_MAX_ITERATIONS`), one model call each. With a higher `maxSteps`, a model that still wanted a tool on the 32nd call ended the loop with no answer, and the turn's failure didn't name the budget. The step check now holds `maxSteps` to 32: the turn fails with `budget-exceeded`, kind `steps`, `limit` 32, and the message adds that a turn makes at most 32 model calls, fewer than its `maxSteps`. A typed answer that doesn't fit on the 32nd call gets no repair the loop couldn't run, so the turn fails with `output-schema-violation`. A `maxSteps` of 32 or less works as before. No API, type or flow change: the turn's flow stays `agent.turn` 1.1.0.

The budget docs now give the real defaults. `defineAgent`'s doc said `maxSteps` 6, `maxCostUsd` 0.1 and `maxWallMs` 30 000. They are 8 steps, no cost cap, and 120 000 ms. The `TurnBudget` type, `agent.schema.json`, the agent-authoring skills and the budgets guide now also say a turn makes at most 32 model calls.
