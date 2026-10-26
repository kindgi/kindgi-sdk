---
"@kindgi/api": minor
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A schedule or webhook trigger is personal or shared, and its owner stays put.** A trigger a person owns is personal: its runs act as them, with their connections, and only they or a project admin can change, pause, resume, fire or delete it. Anyone else is answered `403 permission-denied`. A trigger a service account owns is shared: its runs act as the account, with the company's connections. Changing what it runs (its target or version, its input, its tools allowed unattended, a webhook's signing secret) takes a project admin. The project's writers can still change its label, schedule, policies and delivery settings, and pause, resume, fire or delete it. No change moves the owner; only a take-over (`POST …/owner`) does. Without an authorization store, a project admin here is a tenant-admin key, and that covers setting a trigger's tools allowed unattended and taking a trigger over too. A change by anyone but a personal trigger's owner is recorded as `trigger-changed-for-owner`. 0.2.0-rc.0 moved a trigger's owner to whoever changed what it ran; this release doesn't, and a trigger that candidate moved keeps the owner it has now.

Release-decision: 0.2.0, the maintainers, 2026-10-22
