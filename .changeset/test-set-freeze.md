---
"@kindgi/api": patch
---

**Freezing an agent's test set.** `createTestSetFreeze({ corrections, testSets, cases })` is a `TestSetFreezeBinding` built over the bindings, for a runtime to pass as `testSetFreeze`.

- **What it freezes.** It freezes a project's active cases of an agent's test set, oldest added first, as a version `1.0.<n>` of the test set `agent.<agentId>.<projectId>` (kind `corrections`).
  - Each case is a copy of its run (its segment path included), with what it expects.
  - A case whose run's copy is gone is frozen `erased`.
- **When it makes a version.** A new version is made only when the cases changed: a hash of their ids and `updatedAt` decides. Otherwise the newest version is answered again.
- **Whose test set it writes into.** It writes nothing into a test set whose newest version doesn't name the agent and project in its `spec`. It throws instead.
- **Who can read it.** A version is published with its project as its parent, so reading it needs read on the project.
- **Run copies.** The corrections binding gains `runCopies({ tenantId, runIds })`. It answers the stored copies of up to `RUN_COPIES_MAX` (100) runs, each as a correction's `get` answers its `run`.
  - A run with no copy is left out.
  - More ids throw a `RangeError`.
- **A frozen case.**
  - A case gains an optional `expect` (`TestCaseExpect`): what it expects of a run. A grader reads it when it's present, and `items` and `corrections` otherwise.
  - A case gains an optional `segments`: the segment path its run was started with, from the run's copy.
  - A case to store (`EvalCaseToStore`) can carry the run it was copied from (`runId`), for an erasure to find it by. The store never answers it on a read.
