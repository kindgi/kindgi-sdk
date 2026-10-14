---
"@kindgi/agents": patch
---

- Fixed: a guardrail scoped to flows (`scope.flows`) applies to the agent turns of those flows' steps. Before, a turn's trace never named its flow, so the guardrail was skipped on every turn, and nothing said so.
- The guardrail gate gives the trace the flow whose step started the turn: the flow of the turn's parent run, read from the turn's own run once it has resumed. A turn outside any flow names none, and a guardrail scoped to flows skips it, as before.
- A replay of a past turn (`replay.of`) gets the flow of the turn it replays, through a replay of a replay too, so a guardrail scoped to flows applies to it as it did to the original turn.
- A turn with guardrails whose runs can't be read fails its step with `persistence-error`, so a guardrail scoped to flows is never passed over unseen. So does a replay whose chain of replays loops or goes on past 10. A turn with no guardrails reads no run.
