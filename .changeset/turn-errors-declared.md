---
"@kindgi/agents": patch
---

**Every error an agent turn returns is declared in `InvokeAgentError`, so a typed caller's `switch` on `code` sees each one.**
- `run-journal-unavailable` (`RunJournalUnavailableError`): `resumeAgentTurn` couldn't read the run's journal. Resuming again may work.
- A turn that ends at an approval gate. Each of these is a person's outcome, as the approvals reference says:
  - `hitl-rejected` (`HitlRejectedError`): a reviewer rejected the turn at its session gate, or, in a replay, the past run's reviewer did. It carries the reviewer's `rationale`, when they gave one.
  - `hitl-cancelled` (`HitlCancelledError`): nobody decided in time. It carries the wait's `reason`.
  - `hitl-withdrawn` (`HitlWithdrawnError`): a reviewer withdrew the approval.
- `resumeAgentTurn`'s `agent-version-mismatch` now carries `conversationId`, as `AgentVersionMismatchError` says it does.

The codes and messages are unchanged; before, the turn returned them outside its declared type. A `switch` on `code` that checks every case (with `never`, or an `assertNever`) now has to handle these four codes to compile.
