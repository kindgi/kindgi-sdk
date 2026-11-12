---
"@kindgi/api": patch
"@kindgi/client": patch
---

The operator of a runtime that serves several tenants can register a signed build into one project of a tenant: `POST /v1/system/tenants/{tenantId}/deployments`, on a system key holding the new scope `system:hosted-builds` itself (`kindgi:system` doesn't stand in for it). It takes `POST /v1/deployments`'s body and gives its answers, through the same checks: it's the tenant's deploy, under the project-only key scope. The body's `projectId` is required, the record's `keyScope` is `project`, and the build's schemas count against the tenant's compile budget. As the caller, the key reads and administers that one project and nothing else. A suspended or closing tenant is refused (`409 tenant-suspended`, `409 tenant-closing`), and an unknown or purged one is `404 tenant-not-found`; nothing is registered. The TypeScript client has `systemHostedBuilds.register(tenantId, input)`, and the Python client (`kindgi`) `client.system_hosted_builds.register`.
