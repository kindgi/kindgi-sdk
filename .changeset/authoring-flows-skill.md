---
"@kindgi/sdk": minor
---

A `kindgi-authoring-flows` skill for TypeScript packs:
- `defineFlow` with tool and agent steps;
- edges and `when` conditions, including why `ne` on a missing path never fires;
- branches that join again, `inputMapping` and typed agent output in a flow (`nodeOutputs.<step>.output.<field>`), and the flow's declared `output`;
- loops, fanout, and edge retry and timeout;
- running a flow (`--no-wait`, `--dry-run`) and reading its journal.

`kindgi-authoring-agents` gains "What a turn receives": a direct run's input (`userMessage`, `conversationId`, `parameters`) versus a flow step's structured input (`{{ input.* }}`, `config.parameters`, `config.version`). `kindgi-getting-started` routes flows to the new skill.
