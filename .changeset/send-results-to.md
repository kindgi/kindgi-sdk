---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/runtime": patch
"@kindgi/types": patch
---

**A schedule can send its results somewhere: to its owner's email, or to a destination a workspace admin set up.**
- New resource `/v1/destinations` (`client.destinations`): a named place results go. Its kinds are `email` (workspace members), `slack`, `teams`, `google-chat`, `discord` and `webhook`. Admins create, list, get, update and remove destinations; remove is a soft delete, like connection apps. Each destination also has a test message, a delivery list and redeliver; a redelivered message is checked again, so one skipped for a removed destination, a project it's no longer for or a person without access stays skipped. A chat or webhook `url` is a credential: it is write-only and never returned. `content` is `link` (the default: the run's status and a link to it) or `answer`, which also sends the run's answer and needs `projects`. With `?projectId=`, anyone who may run in that project lists the destinations its schedules may use, with what picks one and without where they send: no `host`, `urlRef`, `secretRef`, `people` or `projects`. A schedule sends one place at most 30 messages an hour; it skips the rest, and one `rate-cap.summary` message at the hour's end says how many.
- A schedule gains `sendResultsTo`: at most five `{ to, on }`, where `to` is a destination id or `me` and `on` is any of `completed`, `failed`, `cancelled` and `waiting` (all four when left out). A save checks each destination: it must exist, and the schedule's project must be one it is for. `me` needs a schedule owned by a person, on a deployment that sends email, and a schedule that sends to `me` can't be handed to a service account. A change is a new schedule version, and its owner hears of a change someone else made. `GET /v1/schedules/{triggerId}/deliveries` (`client.schedules.listDeliveries()`) lists where its results went.
- `GET /v1/runs` takes `completedAfter`, `afterRunId`, `completedBefore` and `startedBy`. The completion bounds page by `(completedAt, id)` in ascending order and can't be combined with `cursor`. To ask for the next page, set `completedAfter` and `afterRunId` to the last run's `completedAt` and `id`.
- The `run.finished` event gains `trigger` and `startedBy`, and `approval.requested` gains `runId`. All three are optional.
- A runtime before Kindgi 0.7.0 ignores the new fields and parameters and doesn't serve `/v1/destinations`.
