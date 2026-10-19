---
"@kindgi/api": patch
---

**Opening a conversation, and registering or changing a schedule or a webhook trigger, checks the version it names.** Each now asks whether the project runs that version, not only whether it reaches the agent or flow. If it doesn't, for example a version made in an earlier environment of an environment order and not yet promoted to this one, it's refused with **`400 reference-out-of-scope`**, the message and the issue naming the version, and nothing is opened, registered or changed. Before, it answered `201` or `200`, and every turn or fire was then refused.
- `POST /v1/conversations`: the agent at `agentVersion`, at `/agentId`.
- `POST /v1/schedules`, and `PATCH /v1/schedules/{triggerId}` with a new target: a flow at `flowVersion`, or an agent at `agentVersion` when one is named, at `/target`. An agent target that names no version, and an improve target, are checked by the agent's id, as before.
- `POST /v1/webhooks`: the flow at `flowVersion`, at `/flowId`.
- `PATCH /v1/webhooks/{triggerId}` with a new `flowVersion`: the trigger's flow at that version, at `/flowVersion`. Before, a new version was checked only for `execute` on the flow.
