---
"@kindgi/api": patch
"@kindgi/agents": patch
"@kindgi/client": patch
---

An approval and the run waiting on it end together.
- **A reviewer's withdraw ends the run:** on a gate approval it cancels the run's waitpoint, and the turn fails with `hitl-withdrawn` ("The approval for … was withdrawn"), right away instead of at the approval's deadline. Every `hitl-*` failure is a person's outcome, not an error.
- **A run's end withdraws its open approvals:** they show `withdrawnBecause` (`run-cancelled` or `run-failed`).
- **A decision on an approval whose run has ended is refused before anything is recorded:** `409 run-already-terminal`, with the ended run's `runId` and `status` in `details`. A decision recorded just before the run ended stands: the answer has `waitpointResolved: false` and the run's `runStatus`.
- **Approvals carry `requestedBy`, `separateApprover`, `escalatedFrom` and `escalatedTo`.** `identity.whoami` returns the caller's `actor` in the same form as `requestedBy`.
- **The approvals list takes `runId`, and `includeDescendants`** for the runs inside it.
