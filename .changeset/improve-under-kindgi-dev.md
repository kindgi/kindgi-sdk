---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
"@kindgi/sdk": patch
---

**Improve runs under `kindgi dev`.** Where the agent registry is read-only but takes Improve's candidates (`RegistryReadOnly.takesCandidates`), `POST /v1/improve-runs` and `POST /v1/improve-runs/check` go through: the run counts in its project, and its suggested change is for the whole workspace (the `tenant` scope). Pinning that change (`POST /v1/suggested-changes/{suggestedChangeId}/pin`) pins it for the whole workspace, through the project its version was made in. Its test runs check the project the registry places the agent in, where no `itemProjects` binding says which projects serve it, so a pin there marks what its check fixed, as on a deployed runtime; rights and `?projectId=` reads still have no binding. One built on a version that no longer runs is `409 suggested-change-out-of-date`, and isn't rebuilt. A suggested change made by hand, and a check again, are refused there with the new optional `takesCandidates.byHandReason`, and an add as Latest with `latestReason`; without them, with the registry's `reason`. Either comes before any `suggested-change-not-for-a-project`.

A suggested change now keeps what its block held as it was drafted, and on a rebuild what it held then (`ProposedChange`'s optional `change.before`). `GET /v1/suggested-changes/{suggestedChangeId}` reads `changes[].before` from it, and from `fromVersion` for one kept without it, as before.

`PackBlockWrite` gains an optional `expected`: what the block's file must hold for the write to go. A file edited since, even at the same version, is refused with the new reason `changed`, naming the file, and the pack service's `POST /v1/blocks` answers `409` for it. `definitionKey`, `tookEffect` and `candidatesPinProjects` are exported from `@kindgi/api`.

The `returns-helper` template's README walks the loop on `kindgi dev` end to end: correct a run, then fix it in the pack, or run Improve, pin its suggested change and approve the pin yourself, which writes it into the pack's files, and see the correction become Fixed; going back there is git. The `kindgi-fix-corrections` skill says the same for an agent helping a person.
