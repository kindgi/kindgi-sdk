---
'@kindgi/api': patch
---

A session can carry an API key's limits. A session store's `create` takes, and its `get` and `resolveToken` return, an optional `projectId` and `role`, and the API reads them as it reads a key's:
- a request naming another project is refused (`403 key-project-mismatch`);
- a `member` session takes no admin action on the tenant.

A session limited to a project is held tighter than a key above its project. It takes no action on the tenant, an org or a team, reading included, so it can't read the tenant's settings. A key limited to a project keeps its rule, since its holder is its principal.

Such a session also:
- mints no keys (`403 limited-session-cannot-mint`);
- isn't refreshed (`400 limited-session-not-refreshable`), so no copy of it comes back without its limits.

`whoami` reports its `projectId` and `role`, and refusals say "this session is limited to project …" instead of naming an API key. Sessions without limits are unchanged, and nothing creates a limited session yet.
