---
"@kindgi/cli": patch
---

`kindgi proposals improve` asks the runtime to look for better values for an agent version's tunable settings, for a scope, on a test set:
- It takes `--max-cost` (US dollars) and `--max-candidates`.
- It answers with the pass. `--wait` waits for the outcome: the proposal it wrote, or why it found nothing better.

`kindgi proposals passes list|get|cancel` reads passes and stops a running one. `list --table` shows the candidates compared, the cost and the outcome.
