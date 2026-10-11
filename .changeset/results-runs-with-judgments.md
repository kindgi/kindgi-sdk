---
"@kindgi/api": patch
"@kindgi/client": patch
---

A judging rule's results count the runs their judgments come from: `runsWithJudgments` on each group (`GET /v1/projects/{projectId}/judging-rules/{ruleId}/results`). It counts the queued runs with at least one live judgment, whether the run's item is closed as `judged` yet or still `open`. Several people judging one run make several `judgments` but one run here, so a yes share's sample can be sized by runs, not only by judgments. It's optional: a runtime that doesn't count them leaves it out. The TypeScript client's types and the Python client (`runs_with_judgments`) carry it.
