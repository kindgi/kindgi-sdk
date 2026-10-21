---
"@kindgi/api": patch
---

**A retry with the same `Idempotency-Key` now gets its `204` again.** On a route that answers `204`, a retry with the key and body of a request that succeeded was answered `500`, though the change had been made once and wasn't made again. Now it's answered `204` with no body and `X-Idempotent-Replay: true`, as other replays are.
- **The routes:** changing or deleting an org, a project or a team (`PATCH` and `DELETE` on `/v1/orgs/{id}`, `/v1/projects/{id}` and `/v1/teams/{id}`), changing or removing a project's or a team's member (`/v1/projects/{id}/memberships/{userId}`, `/v1/teams/{id}/memberships/{userId}`), and changing or removing a team's grant on a project (`/v1/projects/{id}/team-grants/{teamId}`).
- **A stored `205` or `304`** is replayed with no body the same way.
- **Answers stored before this change** replay correctly too: what the store holds doesn't change.
