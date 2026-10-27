---
"@kindgi/api": patch
"@kindgi/runtime": patch
"@kindgi/client": patch
"@kindgi/compliance": patch
"@kindgi/specs": patch
---

**Mail triggers on the wire: each new mail in a Gmail or Outlook mailbox starts a run.** With a trigger registry, a server answers `/v1/mail-triggers` when its `triggerKinds` include `mail` (left out, all four kinds mount).
- **`POST /v1/mail-triggers`** registers one:
  - the agent (`agentId`, with `agentVersion` optional) or the flow (`flowId` and `flowVersion`) to run;
  - `config.mailbox`, `{ app: 'google' | 'microsoft', as: 'person' | 'company' }`;
  - `config.folder`, the Gmail label id or the Outlook folder id or well-known name to watch (the inbox when left out, and `INBOX` or `inbox` to watch it again);
  - `config.pollSeconds`, how often to look, 30 to 3600 (default 60), and `config.runsPerHour`, the most runs its mail starts in an hour, 1 to 600 (default 60).
  - `projectId`, the trigger's project (the tenant's Default project when left out). One that isn't a project id is a `400`, and one that names no project of the tenant's is a `404 project-not-found`, as for schedules and webhooks.
  - Each run's input is the mail that started it, so `config.input` is refused.
- **Whose it is.** A trigger is shared or personal, by its owner, and its runs act as that owner, with the owner's connections.
  - A trigger on a person's mailbox reads its owner's own mail, so a person owns it. A project writer registers one for their own mailbox. `runAsServiceAccountId`, or a service account calling, is a `400`.
  - A trigger on the company's mailbox is a project admin's to register. With `runAsServiceAccountId`, a service account owns it, and it's shared.
  - No edit moves the owner. Only `POST /v1/mail-triggers/{triggerId}/owner` does, and on a person's mailbox the mailbox becomes the new owner's own.
- **Who may change it.**
  - A person's trigger is changed, paused, resumed or unregistered by its owner or a project admin, and anyone else gets a `403`.
  - Only the owner chooses what a person's trigger reads from their mailbox: another of their mailboxes, or another folder. Anyone else, a project admin included, gets a `403`, and may take the trigger over to watch their own. An admin may still move it to the company's mailbox.
  - A shared trigger's `PATCH` is an admin's, and its pause, resume and unregister need `write`.
  - A change to a trigger on the company's mailbox, before or after the change, takes an admin.
  - When an admin changes, pauses, resumes or unregisters a person's trigger, it's recorded as `trigger-changed-for-owner` evidence: the owner, who did it and what, and on a change the fields that changed, with the target, mailbox and folder before and after. Where the app tells owners (`triggerOwnerNotices`), the owner is told too, as for schedules and webhooks, and a take-over tells the former owner. Its runs go on acting as that person.
- **`toolsAllowedUnattended`.** In a run a mail started, every call that changes something, or that uses the run's own mailbox, waits for a person's yes. The list names the tools whose calls needn't wait: only tools its agent or flow calls, and a project admin's to set. While it lists any, a new target (another agent or flow, not just a version) or another mailbox must name it again: `[]` to clear it, which a person's trigger's owner may give with their own change, or a list, which a project admin sets.
- **Reads and the rest.**
  - `GET /v1/mail-triggers` lists them (`projectId`, `status`, paged), and `GET /v1/mail-triggers/{triggerId}` reads one. Each gives `account`, the mailbox's account at its last poll, `lastPolledAt`, and `statusReason` (`connection-missing` while the mailbox's connection is gone or lapsed, `owner-refused` while its owner was removed or may no longer run the target).
  - `POST …/pause`, `POST …/resume` and `POST …/unregister` work as for the other trigger kinds. A resume starts afresh: mail that came while it was paused doesn't start runs.
  - `GET /v1/mail-triggers/{triggerId}/fires` lists its mail, newest first: the run each started, `pending` while an earlier mail of its thread runs first (`detail` starts `thread-busy:`), or why it was skipped, refused or failed, each in `detail`.
- **The trigger types** (`@kindgi/runtime`): the registry's mail trigger record, its config and limits, and the mail fire outcomes, which the wire describes.
- **Clients:** `client.mailTriggers` in the TypeScript client, and `client.mail_triggers` in the Python client. In Python, a registration's `config` is a `RegisterMailTriggerBodyConfig`, and a change's is a `PatchMailTriggerBodyConfig`.
