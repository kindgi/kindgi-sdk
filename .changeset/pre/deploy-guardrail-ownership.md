---
"@kindgi/api": patch
---

A deploy keeps a guardrail id that's already registered only if it's the deploy's own: in the project the deploy registers into (the tenant's Default project), with the same definition. Before, `already-registered` always counted as success, so two cases went through silently:
- **Another project's guardrail with that id:** the pack's agents would run it. Now the deploy is refused with `409 guardrail-project-mismatch`, without naming that project.
- **A changed guardrail in the same project:** the old definition stayed in force. Now the deploy is refused with `409 guardrail-already-registered`; unregister the guardrail and deploy again.

In either case nothing is deployed, and what the deploy had registered is rolled back. Only what a guardrail's author declares is compared (its check, kind, action, config, scope, severity and the rest, plus its code's module path). What a deploy or a release derives isn't: the image and artifact version its code points into, a `configSchema` (a 0.1.4 deploy stored none), and fields a later release adds. So an unchanged pack still redeploys, from a new image and across releases.
