---
"@kindgi/api": patch
"@kindgi/client": patch
---

A project's **judging rules** say which of its runs need a person's judgment, and the runs they match as they end wait in the project's **judging queue**: `client.projects.judgingRules` and `client.projects.judgingQueue` (Python: `projects.judging_rules`, `projects.judging_queue`).
- **A rule** matches by agent or flow, version (`live` included), how the run ended and dry runs, and queues a `sample` of those runs, at most `maxOpen` waiting at once. `judgeClassId` says whose judgment it wants. Each change is a new version (`versions` lists who changed what), `preview` answers how many of the last 100 runs it would have queued, and `results` gives per agent version the runs it queued and the weighted `yes` share of their judgments.
- **The queue** lists runs oldest first, without their content, filtered by state, agent, rule, judge class, `forMe` and time; `limit=0` answers only the `total`. An item closes as `judged` once each rule that queued it has the judgment it wants; `dismiss` and `reopen` take a run out and put it back, and each item's `can` says whether the caller may.

Reading takes project `read`; changing rules, dismissing and reopening take project `write`, as judging does. A rule only lists runs: it never runs a model.
