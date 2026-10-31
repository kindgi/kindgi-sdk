---
"@kindgi/api": patch
"@kindgi/platform": patch
"@kindgi/client": patch
---

**A project can sort its end users' corrections like the others.** A project has `sortEndUserCorrections`, `false` by default, which `PATCH /v1/projects/{projectId}` sets (admin on the project) and `GET` reads back. While it's off, an end user's correction (one with a `participantId`, and not an expert's) stays open and unsorted, as before, and never starts Improve. Once it's on, a correction saved after that is sorted like the others: a wrong answer goes to Improve and wrong decisions go to the agent's owner. A schedule that counts every correction (`groupWeights: "as-recorded"`) counts those sorted to improve toward its threshold only while it's on; once it's off, it leaves them out, even ones sorted while it was on. **Upgrading from 0.3:** a schedule saved with `groupWeights: as-recorded` counted end users' corrections too; from 0.4.0 it counts them only while the project's `sortEndUserCorrections` is on, so turn it on to keep counting them. `@kindgi/platform`'s `Project` and `ProjectPatch` carry it, and the clients' `projects.update` takes it.
