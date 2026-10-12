---
"@kindgi/cli": patch
---

`kindgi projects production <project-id> on|off|status` puts a project in production, takes it out, or says whether it's in production. A run in a project in production is a production run; a run anywhere else is staging. `on` and `off` are for tenant admins, and setting what's already set changes nothing. It prints one line, or `{ projectId, productionSince }` with `--json` (`productionSince` is `null` while the project isn't in production). A refusal names its own code: `production-not-allowed`, whose message says how the tenant gets allowed when the runtime names it; `permission-denied` for someone who isn't a tenant admin; or `tenant-not-found`. It exits 1 when refused, and 2 for anything but `on`, `off` or `status`.
