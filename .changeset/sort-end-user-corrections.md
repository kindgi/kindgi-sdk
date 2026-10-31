---
"@kindgi/api": patch
"@kindgi/platform": patch
"@kindgi/client": patch
---

**A project can sort its end users' corrections like the others.** A project has `sortEndUserCorrections`, `false` by default, which `PATCH /v1/projects/{projectId}` sets (admin on the project) and `GET` reads back. While it's off, an end user's correction (one with a `participantId`, and not an expert's) stays open and unsorted, and never starts Improve, as before. Once it's on, a correction saved after that is sorted like the others: a wrong answer goes to Improve and wrong decisions go to the agent's owner. A schedule that counts every correction (`groupWeights: "as-recorded"`) counts them toward its threshold while it's on: at its next check, every one since its last run, older ones included. `@kindgi/platform`'s `Project` and `ProjectPatch` carry it, and the clients' `projects.update` takes it.
