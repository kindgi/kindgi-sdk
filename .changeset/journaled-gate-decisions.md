---
"@kindgi/handler": patch
"@kindgi/runtime": patch
"@kindgi/agents": patch
---

An approval gate keeps its decision when the turn resumes. A turn that parked on a gate decided again on resume, from the policy and conversation as they were by then: a rule relaxed meanwhile skipped the gate, so a reviewer's reject was never read and the tool ran; a turn completed meanwhile changed the session gate's token, so the decision was ignored and the turn parked again.

- `NodeContext.record(key, decide)` (`@kindgi/handler`): decide once per step. The first call journals `decide`'s result; when the step runs again after a wait, the call returns it without deciding again. The journal entry is `value.recorded`, derived into `DerivedRunState.recordedValues` (`@kindgi/runtime`, `recordedValueKey`).
- `record` is a new required member of `NodeContext`: a test double that builds its own `NodeContext` adds it. A decision outlives a retry of the step as well as a wait; calls for one key at the same time share one decision; the first call returns the JSON the journal keeps, as a replay does.
- `NodeContext.clockNow` replays as documented: when the step resumes after a wait, its calls return the times they read before, in call order. A retry after a failure reads the clock afresh.
- The session and tool approval gates (`@kindgi/agents`) decide through `record`. A gate not yet reached follows the policy as it is now.
- `resumeAgentTurn` reports a snapshot it couldn't read as `run-snapshot-unreadable` (resuming again may work), apart from `run-snapshot-missing`. Both are declared: `RunSnapshotError` in `InvokeAgentError`.

Upgrading: a turn that parked on a gate under an earlier runtime has no recorded decision, so when this runtime resumes it, its gate decides once more from the current policy, as before.
