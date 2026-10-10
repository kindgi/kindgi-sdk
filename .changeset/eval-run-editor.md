---
"@kindgi/api": patch
---

A project editor can start an eval run. `POST /v1/eval-suites/{suiteId}/runs` takes `execute` on the suite (an editor of its project, or an executor), `write` on the project the run lands in and `execute` on the agent or flow it runs; it took `admin` on the suite before, so only a project admin could run a test set. Unregistering or reinstating a suite version still takes `admin` on the suite.
