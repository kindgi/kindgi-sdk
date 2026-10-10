---
"@kindgi/api": patch
"@kindgi/client": patch
---

A project's **judging rules** say which of its runs need a person's judgment, and the runs they match as they end wait in the project's **judging queue**: `client.projects.judgingRules` and `client.projects.judgingQueue` (Python: `projects.judging_rules`, `projects.judging_queue`).
- **A rule** matches by agent or flow, version (`live` included) and dry runs, and queues a `sample` of those runs, at most `maxOpen` waiting at once. `judgeClassId` says whose judgment it wants. Only completed runs can be judged, so `when.status` takes `completed` only for now (`failed` and `cancelled` are refused with 400).
  - **Versions:** each change is a new version, and `versions` lists who changed what.
  - **Preview:** `preview` answers how many of the last 100 runs a rule would have queued.
  - **Results:** `results` groups by the rule's version and the agent's version. Each group has the runs queued and the ones `maxOpen` skipped (`skippedByCap`), plus the weighted `yes` share of their judgments and a count by class.
- **The queue** lists runs oldest first, without their content. It filters by state, agent, rule, judge class, `forMe` and time; `limit=0` answers only the `total`.
  - Each item names the rules that queued it, at the version that did, and its `can` says what the caller may do.
  - An item closes as `judged` once each of its rules has the judgment it wants.
  - `dismiss` and `reopen` take a run out and put it back.

Reading takes project `read`; changing rules, dismissing and reopening take project `write`, as judging does. A rule only lists runs: it never runs a model.
