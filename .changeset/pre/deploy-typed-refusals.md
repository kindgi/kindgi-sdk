---
"@kindgi/api": patch
---

A deployment fails, and rolls back what it published, when one of its tools, guardrails, agents or flows comes back from its registry refused with a typed outcome such as `project-not-found`. Before, `POST /v1/deployments` kept only `ok`, and skipped every other outcome, so the deployment was recorded without that primitive. It now answers that outcome's own status and code (`404 project-not-found`), with `details.primitive` and `details.id` naming the primitive: "The agent acme.drafting@1.0.0 wasn't published: project-not-found; nothing was deployed". `already-registered` (that id and version are stored) is still skipped, as an idempotent redeploy expects; anything a registry throws is still a 500, rolled back.
