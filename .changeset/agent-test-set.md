---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**An agent's test set.** An agent's corrections are its test set now, read one project at a time under `/v1/agents/{agentId}/test-set` (`client.agents.testSet`). Every correction of the agent's runs is a case, except Won't fix and Removed ones; the set is computed when it's read, so nothing builds it.

- `GET /v1/agents/{agentId}/test-set?projectId=…` answers how many cases are active and retired, and when the newest was added. Once a test run has frozen the set, it also answers `frozenVersion: { testSetId, version }`, the newest version frozen, read from the test set registry under `agentTestSetId(agentId, projectId)`. `GET …/test-set/cases` lists them, newest first: `include=retired` adds retired ones, and `kind=correction,hand` narrows by kind. Both need read on the project.
- `POST …/test-set/cases` adds a case by hand, from a correction's body on one of the agent's finished runs. It has no status, isn't sorted, and nothing that counts corrections counts it. A comparison's replay can't be a case.
- `POST …/test-set/cases/{caseId}/retire` with a `reason` retires a case: it stays listed, and no test run checks it again. There's no un-retire, and retiring a correction's case doesn't change the correction's status. A case retired already is `409 test-case-retired`; one the set doesn't have is `404 test-case-not-found`.
- Adding and retiring need publish on the agent and read on the case's project, or write on that project for an agent more than one project serves.
- `CorrectionRegistryBinding` gains `testSet`, `listCases`, `getCase`, `addCase` and `retireCase`, all required, and loses `listCorrectedRuns` with its `CorrectedRun*` types.

**Test sets built from corrections are gone.** `POST /v1/test-sets/{testSetId}/versions/from-corrections` (`client.testSets.buildFromCorrections`) and `kindgi test-sets from-corrections` are removed, with `buildCorrectedTestSet`, `MAX_CORRECTED_CASES` and the `BuildCorrectedTestSet*` types. A `corrections` test set built before is still read by id, and its cases at `GET /v1/test-sets/{testSetId}/versions/{version}/cases`, but `GET /v1/test-sets` lists it only when asked with `kind=corrections`, as it does an agent's frozen versions, and so does `kindgi test-sets list --kind=corrections`.

**`kindgi exports create`** asks for `corrections` test sets too, and reads each agent's test set in each project it serves, its cases added by hand and retired ones included.
