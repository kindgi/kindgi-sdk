---
"@kindgi/api": patch
---

A flow's agent step that names its version (`config.version`) now has that version checked when the flow is published, reinstated or deployed, by the rule a run of the step follows. A version that doesn't exist, or that the flow's project doesn't run, is refused with `400 reference-out-of-scope` at the step's path, where before the flow was published and its first run failed at that step. A deploy asks the same of a step naming a version of the pack's own agent other than the one the pack brings. An unregistered version is still accepted, as a run takes it.

An agent or flow registry's `publish` can answer a new outcome, `held-version-gone`: a version the new agent or flow version holds was removed while it was published, and nothing was written. `POST /v1/agents`, `POST /v1/flows` and a deploy answer it as `400 reference-out-of-scope`, with an issue at each path that names a removed version. Publishing again gets the answer for a missing version: a version a step names is refused, and a pinned one is pinned afresh.
