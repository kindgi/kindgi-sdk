---
"@kindgi/authz": patch
"@kindgi/api": patch
---

Judging a run needs `write` on the run's project, as cancelling one does: a run inherits its permissions from its project. With authorization on, judging was refused for every run, because it asked for a `judge` permission on the run itself, which no run has. The unreleased `judge` action is gone from `@kindgi/authz`.
