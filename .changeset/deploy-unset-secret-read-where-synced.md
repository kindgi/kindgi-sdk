---
"@kindgi/api": patch
---

**A deploy into a project now reads its tools' secrets where its secrets sync writes them.** When a secret a tool names is set nowhere yet, `POST /v1/deployments` with a `projectId` now records that project as where the secret is read, not the broadest scope the deployer administers. So a first `kindgi deploy --project <projectId> --sync-secrets` by a tenant's admin or an org's admin, or on a runtime with authorization off, now reads the values it just synced. Before, the tool's secret was recorded at the tenant (or the org), the sync wrote it to the project, and a call couldn't read it.
- **What changes for you:** if you deploy into a project and then set the secret tenant-wide (`kindgi secrets set <name> --env=<env> --scope=tenant`), a tool version deployed that way no longer reads it. Set it at the project instead: `kindgi secrets set <name> --env=<env> --scope=project:<projectId>`.
- **A secret already set is still read where it's found first,** among the scopes the deployer administers: the project, then its org, then the tenant. A secret set later somewhere else still changes nothing for a version already deployed.
- **A promotion** records the target project for a secret set nowhere, which is where `kindgi promote` tells you to set it.
- **Unchanged:** a deploy with no `projectId` (it needs admin on the tenant; its secrets sync writes to the tenant, and the tenant is recorded), a project admin's deploy, and what `POST /v1/tools`, MCP endpoints and webhook triggers record.
- **A tool version deployed before this change keeps what it recorded; nothing is rewritten.** If its secret was recorded at the tenant and synced into the project, set the secret at the tenant too, or deploy a new version of the tool: the new version records the project.
