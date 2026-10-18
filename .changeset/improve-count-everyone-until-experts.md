---
"@kindgi/api": patch
---

**An improvement pass's `classWeights` now defaults to the project, not always to trusted judgments.** Until a project names an expert judge class — one restricted to named asserters (`assertableBy` set) — `POST /v1/proposals/improve` and improve schedules that omit `classWeights` count *everyone's* judgments (`as-recorded`); once the project has an expert class, the default is trusted judgments only (`restricted-only`), as before. An explicit `classWeights` on the request always wins, and each schedule fire resolves the default against the project as it stands then. A deployment that wires a judgment registry into the app gets this; with none wired, the default stays `restricted-only`.
