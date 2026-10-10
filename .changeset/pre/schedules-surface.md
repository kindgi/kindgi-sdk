---
"@kindgi/runtime": patch
"@kindgi/api": patch
"@kindgi/testing": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

Schedules run an agent or a flow, as their owner, with a catch-up and an overlap policy, a fire history and run-now. There's also a `kindgi schedules` command group.

**`/v1/schedules`:**
- **What it runs:** a schedule names `flowId` with `flowVersion`, or `agentId` (with an optional `agentVersion`; without one, its live version, as a run that names none).
- **An agent schedule's input** is the agent payload, so `config.input.userMessage` is required (400 without it, on register or when a change would leave it out); a flow schedule's input is the flow's own.
- **`projectId`:** default, the tenant's default project.
- **`owner`:** the principal that registered it. Its runs act as the owner, checked again at every fire.
- **`catchUp`:** after a gap, `latest` (the default) runs once for the latest missed occurrence, and its fire says how many it missed; `skip` drops them. Never a run per missed occurrence.
- **`overlap`:** while the previous run is still going, `skip` (the default) records the fire as skipped; `allow` starts another.
- **`startingDeadlineSeconds`:** default 600.
- **`statusReason`:** set when the runtime paused a schedule. Repeated refused or failed fires pause it; skipped ones never count.
- **`skipped-erasure`:** a fire whose person is being erased is recorded as `skipped-erasure` (the run start answered `erasure-in-progress`), so an erasure that waits on a shared flow can't pause an hourly schedule.
- **New routes:**
  - `GET …/{id}?upcoming=N` shows the next occurrences;
  - `GET …/{id}/fires` is the fire history;
  - `POST …/{id}/run-now` fires it now, `manual: true`;
  - `POST …/{id}/owner` lets an admin take a schedule over.
- **Authorization,** with an authorizer:
  - `read` on the schedule's project to read;
  - `write` to change;
  - `admin` to take ownership;
  - registering or retargeting also needs `execute` on what it runs.
- **Kind check:** pause, resume, unregister and the new routes answer 404 for another kind's trigger.
- **Fixed:** registering a schedule or an event trigger refused every body (`config.cronExpression is required`).
- **`createApp({ triggerKinds })`** mounts only the kinds a deployment fires.
- **The binding:** `TriggerRegistryBinding` gains optional `listFires`, `fireNow` and `setOwner`, and a schedule's record has a `target` (agent or flow). `@kindgi/testing` has `createInMemoryTriggerRegistry`.

**Clients and CLI:**
- **TS:** `schedules.get(id, { upcoming })`, `fires`, `runNow`, `takeOwnership`.
- **Python:** `fires`, `run_now`, `take_ownership`.
- **CLI:** `kindgi schedules list|get|create|update|pause|resume|run-now|fires|take-ownership|unregister`.
