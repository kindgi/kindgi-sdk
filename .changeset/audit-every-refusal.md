---
"@kindgi/api": patch
"@kindgi/authz": patch
---

**The access audit keeps every refusal.** Refusals the API decided before asking the authorization model weren't recorded: what a caller's API key rules out (a `member` key asking a tenant admin's action, a key limited to a project reaching outside it, a key without the capability a write needs) and a caller who isn't a reviewer on the approvals routes. They're now recorded like every other decision, through the binding's new optional `recordDecision` (`@kindgi/authz`), with a `reason` saying which check refused.
- `refused()` (with `capabilityRefusal()`) is the one way a route refuses on its own check: it records and answers `403 permission-denied`, the route's message unchanged, with `action`, `resource` and `reason` in the details.
- A check the authorization model can't answer (an action it doesn't define on the type) is recorded as one, and a test over every operation fails on it.
- A runtime without `recordDecision` refuses as before, recording nothing more.
