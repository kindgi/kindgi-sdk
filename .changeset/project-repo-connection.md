---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/connections": patch
"@kindgi/platform": patch
---

**A project's repo connection.** `PUT /v1/projects/{projectId}/repo-connection` with `{ connectionId }` sets the company-wide GitHub connection a project opens its block changes' pull requests through, and `DELETE` clears it. Both need `admin` on the project. A connection that isn't there, or was removed, is `404 connection-not-found`; a person's own connection, or another app's, is `400 repo-connection-not-company-github`. `GET /v1/projects/{projectId}` answers `repoConnectionId` while one is set. The project keeps the id only, so a connection removed later reads as none. A runtime whose project store keeps no repo connection answers `501 repo-connection-unsupported`.

- **Platform.** `Project.repoConnectionId`, and an optional `ProjectBinding.setRepoConnection(tenantId, projectId, connectionId | null)` answering `ProjectRepoConnectionOutcome`; the in-memory binding implements it, and the project binding conformance suite checks it with `repoConnection: true`.
- **TypeScript client.** `client.projects.setRepoConnection(projectId, connectionId)` and `client.projects.clearRepoConnection(projectId)`.
- **GitHub permissions.** The GitHub entry adds `contents.read`, `contents.write`, `pull_requests.read` and `pull_requests.write`. A repo connection's GitHub App needs **Contents** and **Pull requests**, read and write; the GitHub connection guide says so.
