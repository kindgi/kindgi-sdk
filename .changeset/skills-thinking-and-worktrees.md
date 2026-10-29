---
"@kindgi/sdk": patch
"@kindgi/cli": patch
---

The skills and a new pack's `AGENTS.md` tell a coding agent two more things. First, where a model's thinking level comes from: the `thinking` in the agent's model-settings block; else the `thinking.default` the model's provider registration gives it (runtime 0.3.0 or later); else no level, so the model thinks as its vendor sets. A guardrail's or an eval's model judge asks for `lowest`. Second, that each linked git worktree runs its own `kindgi dev`, with its own database, dev tenant, user and token, and that it takes the next free port when 4000 is taken, which `.kindgirc.json` records.
