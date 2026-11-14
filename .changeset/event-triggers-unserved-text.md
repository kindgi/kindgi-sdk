---
"@kindgi/api": patch
"@kindgi/client": patch
---

The event-trigger operations' unserved text, and the TypeScript client's comments on events, no longer say the runtime fires schedules only. The runtime also fires inbound webhooks and mail triggers when it's configured for them. They still say event triggers aren't served yet. No route, schema or type changes.
