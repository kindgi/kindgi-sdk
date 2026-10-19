---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A judging rule can now be caught up on runs that ended before it existed.** `POST /v1/projects/{projectId}/judging-rules/{ruleId}/queue-recent` queues the rule's matches among the project's recent runs — `last` of them (newest first) and/or those completed at or after `since` — sampled exactly as the rule samples, and deduped per `(rule, run)` as run-end matching is. `maxOpen` isn't applied: this is a deliberate catch-up. At least one of `last` (an integer 1–1000) and `since` (a date-time) is required, and the body is otherwise refused with `bad-input`. The response is `{ queued, alreadyQueued, alreadyReviewed }`, splitting the matches into the ones it newly queued, the ones this rule had already queued, and the ones whose run was already judged or dismissed (left as they are; an erased run is no longer a match). It needs `write` on the project.

The clients gain the call: `client.projects.judgingRules.queueRecent(projectId, ruleId, { last?, since? })` in TypeScript and `projects.judging_rules.queue_recent(...)` in Python. Two schemas are added, `JudgingQueueRecentInput` and `JudgingRecentQueued`. The change is additive — one route and two schemas, with nothing existing changed. The runtime binding that does the matching ships separately.
