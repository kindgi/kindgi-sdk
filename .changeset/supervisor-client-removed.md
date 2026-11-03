---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
---

**`client.supervisor` is gone.** Every method on it threw `not-yet-wired`, since the API has no supervisor routes. With it go `SupervisorClient`, `SupervisorSpec`, `Supervisor` and `DryRunCriterion`. Observations stay on `client.observations`, and suggested changes on `client.suggestedChanges`. The error code `supervisor-header-missing`, which the API never sends, leaves the API's list of codes and the TypeScript, Python and Java clients.
