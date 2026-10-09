---
"@kindgi/agents": patch
---

`same-user` memory is the run's end user's, never the user a key acts for. A run with no `participantId` used to read and keep same-user memory as the user its credential acts for. An admin's key or an app's service account that starts runs for many customers is one user for all of them, so one customer's turn could recall another's conversations and facts.

- **Reads:** a `same-user` retrieval, of facts or of conversations, in a run that names no end user reads nothing. The turn records why (`degraded: no-participant`).
- **Writes:** the built-in `kindgi_remember` with `same-user` isn't offered in such a run, and `rememberTarget` refuses it.
- **The warning:** the run's result carries a `memory-needs-participant` warning that says to pass the person's `participantId` on each run.
- **With a `participantId`:** same-user memory works as before.
- **Other scopes:** tenant-, project- and conversation-scoped memory is unaffected.
