---
"@kindgi/client": patch
"@kindgi/sdk": patch
---

**`@kindgi/sdk/client` exports every resource client's type, as it says it does**, so you can name the type of any part of a client: `import type { ProjectsClient, ProjectMembershipsClient } from '@kindgi/sdk/client'`. It used to leave out 58 of them, among them `ProjectsClient`, `DeploymentsClient`, `SecretsClient` and the ones under a resource, such as `client.projects.memberships`'s. `@kindgi/client` now exports the eight it left out too: `AgentTestSetClient`, `AuditResourceClient`, `AuthzAuditClient`, `EnvironmentOrdersClient`, `McpPromptsClient`, `McpResourcesClient`, `SecretRotationsClient` and `SignInAuditClient`. Each of them gets its page in the TypeScript API reference. Only types are added: nothing a client does changes.
