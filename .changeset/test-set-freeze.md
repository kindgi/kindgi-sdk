---
"@kindgi/api": patch
---

**Freezing an agent's test set.** `createTestSetFreeze({ corrections, testSets, cases })` is a `TestSetFreezeBinding` built over the bindings, for a runtime to pass as `testSetFreeze`.

- **What it freezes.** It freezes a project's active cases of an agent's test set, oldest added first, as a version `1.0.<n>` of the test set `agent.<agentId>.<projectId>` (kind `corrections`).
  - Each case is a copy of its run (its segment path included), with what it expects and the run it was copied from (`runId`). Two people's corrections of one run are two cases with that run.
  - A case whose run's copy is gone, or whose run was erased, is frozen `erased`.
- **When it makes a version.** A new version is made only when the cases changed: a hash of their ids and `updatedAt` decides. Otherwise the newest version is answered again.
- **Whose test set it writes into.** It writes nothing into a test set whose newest version doesn't name the agent and project in its `spec`. It throws instead.
- **Who can read it.** A version is published with its project as its parent, so reading it needs read on the project.
- **Run copies.** The corrections binding gains `runCopies({ tenantId, runIds })`. It answers the stored copies of up to `RUN_COPIES_MAX` (100) runs, each as a correction's `get` answers its `run`.
  - A run with no copy is left out, and so is an erased run's.
  - More ids throw a `RangeError`.
- **A frozen case.**
  - A case gains an optional `expect` (`TestCaseExpect`): what it expects of a run. A grader reads it when it's present, and `items` and `corrections` otherwise.
  - A case gains an optional `segments`: the segment path its run was started with, from the run's copy.
- **A test run of an agent's own test set.** `POST /v1/test-sets/{testSetId}/runs` with `agent.<agentId>.<projectId>` freezes the set first, through `testSetFreeze`, and runs that version, which the run records as its `testSetVersion`. A dry run freezes it too.
  - It runs only that agent in that project: another agent or project, or a `flowRef`, is `400 bad-input`, and the message names the test set id the run would take.
  - Without `testSetFreeze` it answers `501 suggested-change-check-unsupported`, and with no cases `409 suggested-change-nothing-to-check`, in a suggested change's check's words.
  - Starting it takes `write` on the project and the right to run the agent. The set has no right of its own to check before its first freeze.
  - Other test sets run their latest version, as before.
