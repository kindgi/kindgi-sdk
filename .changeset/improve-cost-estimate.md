---
"@kindgi/api": patch
"@kindgi/client": patch
---

**`POST /v1/proposals/improve/estimate` estimates what an improvement pass would cost, before you start it.** The body is the start body of `POST /v1/proposals/improve`; it changes nothing (no pass starts) and takes no Idempotency-Key.
- **The answer** is `{ estimatedCostUsd?, maxCostUsd, basis: { replays, meanRunCostUsd? } }`, each amount a US-dollar decimal string. `estimatedCostUsd` is `min(budget.maxCostUsd, basis.replays × basis.meanRunCostUsd)` — clamped to the budget cap, so it never exceeds `maxCostUsd`. It's absent when the version has no cost history.
- **`basis`** is what the estimate is built from: `replays`, how many replay runs the pass's comparisons would make, and `meanRunCostUsd`, the version's mean cost over its recent completed runs (absent with no history).
- **Access:** `publish` on the agent, as starting a pass needs. Without improvement passes in this runtime, `501 improve-unsupported`.
- `@kindgi/client`: `proposals.improveEstimate(input)` — the start input without an idempotency key.
