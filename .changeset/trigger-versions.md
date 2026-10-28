---
"@kindgi/api": patch
"@kindgi/runtime": patch
"@kindgi/client": patch
---

**Each change to a trigger makes a version of it, and a run names the version it used.** Registering a schedule, webhook, mail trigger or event trigger makes version 1. A change that alters it makes the next (`cause: 'edit'`), and so does a take-over (`owner`). A change that alters nothing makes none, nor do pausing, resuming or removing it. A version never changes once made. A run uses the newest when it starts, and keeps it whatever later changes make, so a change or a take-over reaches the next run that starts. A version keeps every input it ever had, so a secret pasted into one is rotated, not edited out.
- `GET /v1/schedules/{triggerId}/versions` pages a schedule's versions, newest first, and `GET /v1/schedules/{triggerId}/versions/{version}` reads one; `/v1/webhooks`, `/v1/mail-triggers` and `/v1/event-triggers` have the same. They take read on the trigger, as reading it does. Each version names when it was made (`createdAt`), by whom (`createdBy`, the caller that made the change, never a body's field; absent for one the runtime made itself), why (`cause`: `register`, `edit`, `owner`, `first-fire` or `pin`) and what the trigger was then (`definition`, never its status). A version the trigger doesn't have is `404 trigger-version-not-found`, with `triggerId` and `version` in its `details`.
- A trigger's record has `version`, its newest; a fire has `version`, the one its run used; and a run's `trigger` has `version`. Each is absent from an older runtime, and from a trigger from before versions until its next change or its first fire.
- `@kindgi/runtime`: `TriggerRegistryBinding` has `listVersions` and `getVersion`, both required, and its register, update and `setOwner` inputs have a required `by`, the caller making the change, which the routes fill from the authenticated caller. `TriggerVersionRecord` is the version, one per kind on `kind`. `RunTriggerRef` and `TriggerFire` have `version`. The testing trigger registry (`createInMemoryTriggerRegistry`) keeps versions as a runtime does.
- `@kindgi/client`: `schedules.versions(triggerId)` and `schedules.getVersion(triggerId, version)`, and the same on `webhooks` and `mailTriggers`.
- `POST /v1/schedules/{triggerId}/owner`'s docs say the new owner's runs act as them from the next run that starts.
