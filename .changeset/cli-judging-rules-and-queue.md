---
'@kindgi/cli': minor
---

`kindgi judging-rules` and `kindgi judging-queue`: manage a project's judging rules and the queue they fill from the CLI. For rules: create, list, show, update, remove, list a rule's versions and results, preview what a rule would queue, and queue its matches among recent runs to catch it up on runs that ended before it was there (`queue-recent`; `create` can do it in one step with `--queue-last`/`--queue-since`). For the queue: list the queue's runs by state, agent, rule, judge class or time, or just the ones your judgment would close; dismiss or reopen one.
