---
"@kindgi/sdk": patch
---

**The `kindgi-using` skill knows an approval addressed to one person, and a run that waits for a connect.** It says who decides an approval with an `approver`, and that any decision of a tenant admin's on it, escalating included, is refused (`403 named-approver-required`), while its person approves or rejects it but can't escalate it (`409 invalid-transition`). Asked what a run waits for, it reads `kindgi runs resume <run-id>`'s exit code, and for a connect (`6`) hands over the link the person who started the run connects from. Connecting an app is now among the actions it leaves to the person.
