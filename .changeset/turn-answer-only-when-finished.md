---
"@kindgi/agents": patch
---

**The steps that check and store a turn's answer now take it only from an iteration that finished the turn.** `evaluate-guardrails` and `persist-final-message` read the answer from the loop's last iteration, and took it whether or not that iteration had finished the turn. The step check already fails a turn whose model still wants a tool on its last call, so such an iteration shouldn't reach them. If one does, the turn now fails before any guardrail runs and before anything is stored. When the loop ran out of iterations, it fails with `budget-exceeded`, kind `steps`, `limit` 32, and `observed` the iterations the loop ran. When the loop ended any other way, the loop's output is broken, and it fails with `model-invocation-failed`. No API, type or flow change: the turn's flow stays `agent.turn` 1.1.0.
