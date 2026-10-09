---
"@kindgi/api": patch
---

A deploy keeps a guardrail id that's already registered only if it's the deploy's own: in the project the deploy registers into (the tenant's Default project), with the same definition. Before, `already-registered` always counted as success, so two cases went through silently:
- **Another project's guardrail with that id:** the pack's agents would run it. Now the deploy is refused with `409 guardrail-project-mismatch`, without naming that project.
- **A changed guardrail in the same project:** the old definition stayed in force. Now the deploy is refused with `409 guardrail-already-registered`; unregister the guardrail and deploy again.

In either case nothing is deployed, and what the deploy had registered is rolled back. Where a guardrail's code lives (the image and artifact version it points into) doesn't count as a change, so redeploying an unchanged pack from a new image still goes through.
