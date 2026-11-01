---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/platform": patch
---

**"The default project", not "the Default project".** Error messages, help text, API descriptions and docs now say "the default project" for a tenant's default project: the one with `isDefault: true`, whatever it's named. A tenant created on 0.4.0 or later gets a default project named "First Project", and one created before keeps "Default".

- Error codes are unchanged; only message text changes. For example, `GET /v1/projects/default` with no default project answers `404` with `Tenant has no default project`.
- To find the default project, use `isDefault`, `GET /v1/projects/default` or `client.projects.getDefault()`, never the name "Default" or the slug `default`.
