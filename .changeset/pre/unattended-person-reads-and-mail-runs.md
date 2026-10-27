---
"@kindgi/runtime": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/tools": patch
"@kindgi/specs": patch
"@kindgi/sdk": patch
"@kindgi/client": patch
---

**In a run no person started, a tool that reads with a person's connection now waits for that person's yes too, as one that changes things does; in a schedule's or webhook's run, list it in its tools allowed unattended to run it unasked.** A tool counts when it has an `as: 'person'` connection, whatever its `mutating` says. On a flow's tool step such a call is refused with `needs-a-person`, as a change is.

**A run can say a mail started it.**
- `startedBy` and a run's `trigger.kind` can be `mail`. The two OpenAPI enums are now built from `RUN_STARTED_BY` and the new `RUN_TRIGGER_KINDS`, so they can't drift from the runtime's.
- `RunMailbox` (`app`, and `as: 'company' | 'person'`) is the mailbox a mail trigger's run came from. It's recorded with the run, as `mailbox`, beside `startedBy` and `toolsAllowedUnattended`, and a resumed turn reads it back from its snapshot.
- In a run a mail started, two more calls wait for a person's yes in an agent turn, and are refused in a flow's tool step:
  - a call of any tool that isn't `mutating: false`;
  - a call with a connection of the run's own mailbox, its app and kind, read-only or not.
- A tool the mail trigger's `toolsAllowedUnattended` lists runs without that yes, as on a schedule or a webhook.
- `needsPersonsYesUnattended` takes the run's mailbox as an optional fourth argument.
- `unattendedWaitReason` gives why a call waits, the first that holds: the tool declares it (`declared`), it uses a person's connection (`persons-connection`), or in a mail's run it changes something (`mail-change`) or uses the run's own mailbox (`mail-own-mailbox`). So a refusal can name the reason the rule found. `needsPersonsYesUnattended` is whether it gives one.
- The TypeScript client's `RunTrigger.kind` can be `mail`.
