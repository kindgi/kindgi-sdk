---
"@kindgi/agents": patch
---

`agent_run_snapshots` no longer has a `principal` column. Who a turn acts for is its run's: the runtime has kept it with the run since 0.1.5, and a resumed turn reads it from there. The `@kindgi/agents` migrations drop the column, so the exported `AgentRunSnapshotRow` and `NewAgentRunSnapshotRow` lose `principal`, and a store of your own that reads or writes it through them no longer compiles. `RunSnapshotWriteInput.principal` stays: a store that keeps who started the turn with the run's record may ignore it there, as long as `read` answers the run's.

Before you upgrade a runtime, end every unfinished agent turn that a runtime before 0.1.5 started: `check snapshot-principals` lists them. The runtime refuses to start on a database that still has one, before it migrates anything.
