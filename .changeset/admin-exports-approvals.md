---
"@kindgi/api": patch
"@kindgi/cli": patch
---

**A tenant admin exports the approvals they read.** With authorization on, a person who is a tenant admin signs an approval's audit bundle (`POST /v1/approvals/{approvalId}/audit-bundle`, `kindgi approvals export`) as a reviewer does: the approvals get and list show them, at every tier, with the run's conversation when asked (`includeMessages`). Before, one the reviewer roster doesn't name was `403 permission-denied`, and one it names below the approval's tier was `404 approval-not-found`. Exporting decides nothing, and deciding stays the roster's. An API key with no user still exports nothing.

- A caller who is neither a reviewer nor a tenant admin is still refused. The refusal's `details.action` is now `read`, as for a read, where it was `admin`.
- `kindgi exports create` signs each decided approval's audit bundle, so its signed approvals step no longer fails for a tenant admin who isn't a reviewer.
- `kindgi approvals export --help` and the export guide say who may export. The guide also says compliance evidence is served only where the deployment turns it on, and that Kindgi Cloud doesn't.
