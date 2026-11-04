---
"@kindgi/runtime": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**A run can start from a text message.** `RunStartedBy` gains `text`, for a run a text trigger fired. Such a run is one no person is watching, with the rules a mail-started run has:
- The text is read as outside data, in an `<event>` block, never as the person's own message.
- Every tool that changes something (any tool that isn't `mutating: false`) waits for a person's yes, with the new reason `text-change` (`UnattendedWaitReason`), unless the trigger lists it in `toolsAllowedUnattended`. A read-only tool runs.
- A tool that declares `needsApprovalWhenUnattended`, or uses a person's connection, waits as in any run no person started, unless the trigger lists it.
- A run's `startedBy` in the API can be `text`, and such a run acts for the trigger's owner.
