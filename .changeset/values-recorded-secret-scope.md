---
"@kindgi/api": patch
---

In a deployment's own project, `GET /v1/deployments/{deploymentId}/values` reads each tool secret at the scope its tool version recorded, as a run there does, rather than at the narrowest scope that holds it. A secret revoked where it's recorded reads `revoked` even when a wider scope holds a live one, and one the version recorded as read nowhere reads `missing`, optional or not: a run refuses both. A tool version that recorded no scopes reads the workspace's, as a run there does, so a secret set only at the project reads `missing`. The app options gain `secretLocate`, where a runtime says where its secret store would read a secret, revoked or not, since `get` answers nothing for a revoked one. Without it, a secret revoked where it's recorded reads `missing` when it's required, and isn't listed when it's optional.
