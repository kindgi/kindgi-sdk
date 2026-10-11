---
"@kindgi/api": patch
---

A test set built from judgments leaves out a comparison's replays. Judging a replay's answer is evidence for that comparison, and it no longer becomes a case of a later test set.
- **How a replay is known:**
  - A run's first judgment now stamps its stored copy with the run it replays (`run.context.replayOf`, shown in `GET /v1/judgments/{id}`).
  - An agent turn judged before this stamp is still known, from the replay report its output carries (`replay.of`).
  - `isReplayCopy` states the rule, and `JudgmentRegistryBinding.listJudgedRuns` never lists a replay.
- **The one gap:** a flow's replay judged through the API before this release isn't stamped and can't be told apart, so it still counts. To leave one out, remove its judgments (`kindgi judgments remove <id>`), or build the test set from judgments made since the upgrade (`--since`).
