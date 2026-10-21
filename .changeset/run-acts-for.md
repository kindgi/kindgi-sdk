---
"@kindgi/runtime": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**A run says whom it acts for: `actsFor`.**

- **Where:** `KernelRunRecord.actsFor`, `GET /v1/runs` and `GET /v1/runs/{runId}`. The response field is optional and additive. The TypeScript, Python and Java clients' `Run` gain it.
- **The value** is whom the run acts for, whose access it has: `user:<id>` (a person) or `service_account:<id>` (a service account). These are the same strings as an approval's `requestedBy`, a conversation's `openedBy` and `whoami`'s `actor`. `@kindgi/runtime` exports its type, `RunActsFor`. It is recorded when the run is created and never changes. An approval or a resume doesn't change it.
  - A person who starts a run, signed in or with their own API key, is whom it acts for. So is a service account whose key starts one.
  - A run a schedule or a webhook fired (`startedBy` `schedule` or `webhook`) acts for the trigger's owner when it fired.
  - A child run acts for its parent's.
  - An agent acting for someone acts for that someone.
  - It is absent on a run that acts for no one (a system job, an agent on its own, an eval run's replay run) and on runs from before runs recorded it.
- **An id, never a name.** A run's readers already see these ids on the project's approvals and conversations. Show the caller's own as `you` (`whoami`'s `actor`), and a name only where the caller may read that person or service account.
- **Not on the public view or the webhook.** A public run token's `GET /v1/runs/{runId}/progress` and its stream never carry it, nor does the `run.finished` webhook's run. The journal's `run.started` payload carries it to the run's readers, on `GET /v1/runs/{runId}/journal` and `/stream`.
