---
"@kindgi/api": patch
"@kindgi/runtime": patch
"@kindgi/cli": patch
---

**A mail trigger moved to another mailbox watches that mailbox's inbox.** A change whose `config.mailbox` names another mailbox, in the other app or with the other `as`, and that names no `config.folder` drops the trigger's folder. A Gmail label id or an Outlook folder id belongs to one mailbox, so in another it names another folder or none. The same mailbox sent again keeps the folder, and a folder named with the move is the one it watches.
- The `PATCH /v1/mail-triggers/{triggerId}` body's `folder` says so, and the testing trigger registry (`createInMemoryTriggerRegistry`) merges a mail trigger's config the same way a runtime does.
- `UpdateMailTriggerInput.config` (`@kindgi/runtime`) and `kindgi mail-triggers update --folder` say so too.
