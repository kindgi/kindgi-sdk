---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A pin's test run moves its project's corrections.** When a pin change or Latest moving changes the version a project runs, a test run of that version on the project's test set ends with each correction it checked `fixed` in that version, or reopened.

- **`POST /v1/test-runs` refuses a `correlationId` that starts with `pin:` or `latest:`** (`bad-input`). This is a narrowing: those prefixes name the test runs Kindgi starts itself, `pin:<change id>` for a pin change and `latest:<agent id>:<project id>` for Latest moving.
- **`applyTestRunOutcome(deps, { tenantId, testRunId })`** applies an ended run's outcome, and `reapplyTestRunOutcomes` applies a tenant's ended runs again, newest first. An outcome applies only while the project still runs the version the run tried. A dry run doesn't apply, and neither does a comparison with `overrides`, a `sample` or `rescoreOf`.
- **`CorrectionRegistryBinding.applyRunOutcome`** writes the outcome. It changes only a correction that hasn't changed since the run ended. A correction reopened by a run has `reopenedIn`: the version, and how the project came to run it (`pin`, `went-back`, `unpin` or `latest`), by whom and when.
- **`Pin.ranBefore`** is what ran in the scope just before a pin. A first pin of an earlier version in a scope then reads as going back.
