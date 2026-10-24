---
"@kindgi/sdk": patch
---

**The `kindgi-using` skill knows an approval addressed to one person, and a run that waits for a connect.** It says who decides an approval with an `approver`, and that a tenant admin's decision is refused (`403 named-approver-required`), as is an escalation (`409 invalid-transition`). Asked what a run waits for, it reads `kindgi runs resume <run-id>`'s exit code, and for a connect (`6`) hands over the link the person who started the run connects from. Connecting an app is now among the actions it leaves to the person.
