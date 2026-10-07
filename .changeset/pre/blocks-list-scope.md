---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**`GET /v1/blocks` narrows by project or org like the other lists:** `?scopeKind=project&scopeId=<id>` or `?scopeKind=org&scopeId=<id>`, in place of `?projectId=`. A malformed scope answers `400 scope-invalid`.

- `BlockListInput.scope` (a `Scope`) replaces `projectId`. A block store lists the blocks of the project, of every project in the org, or of the whole tenant.
- TS: `client.blocks.list({ scope: { kind: 'project', projectId } })`.
- Python: `client.blocks.list(scope_kind='project', scope_id=...)`.
- `kindgi blocks list --project=<id>` is unchanged.
