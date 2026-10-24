---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**`kindgi init --template=follow-up`:** an agent that writes a follow-up mail from your notes and sends it from your own Gmail, each send approved first.
- Its send tool is `gmailSend` from `@kindgi/connections`, included under the pack's own id. `init` adds `@kindgi/connections` at the CLI's own version, or linked from a checkout with `--link-local`.
- Its README covers connecting Google, what waits for a person, and why text other people wrote is information, never instructions.
- In an existing app, `init` refuses it and points at `--new-repo`.
- The getting-started skill lists it.
