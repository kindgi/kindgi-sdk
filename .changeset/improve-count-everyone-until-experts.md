---
"@kindgi/api": patch
---

**An improvement pass's `classWeights` now defaults to the project, not always to trusted judgments.** Until an expert judge class — one restricted to named asserters (`assertableBy` set) — is named, `POST /v1/proposals/improve` and improve schedules that omit `classWeights` count *everyone's* judgments (`as-recorded`); once one exists, the default is trusted judgments only (`restricted-only`), as before. The class counts when it's in tenant scope, in the pass's project, or on the agent being improved; a class for another agent, or in another project, doesn't. An explicit `classWeights` on the request always wins.

A schedule that omits `classWeights` resolves the default at each fire, against the project as it stands then, so naming an expert class later takes effect with no edit. A schedule created before this release kept an explicit `restricted-only` and keeps it; recreate it without `classWeights` to follow the project default.

A deployment that wires a judgment registry into the app gets this; with none wired, the default stays `restricted-only`.
