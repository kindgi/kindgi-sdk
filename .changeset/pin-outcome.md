---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A pin's test run moves its project's corrections.** When a pin change or Latest moving changes the version a project runs, a test run of that version on the project's test set ends with each correction it checked `fixed` in that version, or reopened.

- **Starting a test run (`POST /v1/test-sets/{testSetId}/runs`) refuses a `correlationId` that starts with `pin:` or `latest:`** (`bad-input`). This is a narrowing: those prefixes name the test runs Kindgi starts itself, `pin:<change id>` for a pin change and `latest:<agent id>:<project id>` for Latest moving.
- **`applyTestRunOutcome(deps, { tenantId, testRunId })`** applies an ended run's outcome, and `reapplyTestRunOutcomes` applies a tenant's ended runs again, newest first. An outcome applies only while the project still runs the version the run tried. A dry run doesn't apply, and neither does a comparison with `overrides`, a `sample` or `rescoreOf`.
- **`CorrectionRegistryBinding.applyRunOutcome`** writes the outcome. It changes only a correction that hasn't changed since the run ended. A correction reopened by a run has `reopenedIn`: the version, and how the project came to run it (`pin`, `went-back`, `unpin` or `latest`), by whom and when.
- **`Pin.ranBefore`** is what ran in the scope just before a pin. A first pin of an earlier version in a scope then reads as going back.
- **A pin starts the test runs that check it.** For each project the pin moves to its version, with corrections on the project's test set, the pin starts a test run of the version on the test set as frozen, with `correlationId` `pin:<change id>`. A pin that names a finished test run of the same version, test set version and project (`testRunId`) reuses it: the corrections it checked are `fixed` or reopened at pin time. A pin that waits for an approval starts its runs at once, and they apply when it's approved (`pinTookEffect`). A project whose run can't start is left out and logged; the pin still answers.
- **`POST /v1/agents/{agentId}/pinned/pin` answers `{ pin, testRuns, fixed, reopened }`** (`PinAnswer`): the pin change under `pin`, the test runs that check it, and the corrections a reused run changed. Still `201`, and `202` while it waits. `agents.pinned.pin` and `kindgi agents pin` give the same shape.
- **`POST /v1/suggested-changes/{id}/pin` answers the same shape, with the suggested change under `suggestedChange`** (`SuggestedChangePinAnswer`). `suggestedChanges.pin` and `kindgi suggested-changes pin` give the same shape.
