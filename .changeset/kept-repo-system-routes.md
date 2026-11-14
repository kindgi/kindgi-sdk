---
"@kindgi/api": patch
"@kindgi/env-schema": patch
"@kindgi/client": patch
---

A runtime serving many tenants can keep a git repo for each project without a GitHub repo, in a repo store beside it, with `KINDGI_KEPT_REPOS=on` on the runtime and on the store's gateway (off by default). The runtime keeps the record, and the store asks it what to do:

- `system:kept-repos`, the store's key: `POST /v1/system/kept-repos/rulings` rules on up to 500 repos at once (`keep` with its mark, or `purge` for `erasure`, `retention`, `tenant-purged` or `no-record`), `GET /v1/system/kept-repos/erasures` lists the unfinished erasures, and `POST /v1/system/tenants/{tenantId}/projects/{projectId}/kept-repo/purged` reports a purge done (`204` whatever the tenant's state).
- `system:kept-repos:erase`: `POST /v1/system/tenants/{tenantId}/projects/{projectId}/kept-repo/erasure` requests a repo's erasure (`202`, or `200` when its erasure is done already; `404 project-not-found`, `409 legal-hold`, and `501 kept-repos-off` while the setting is off), and `GET /v1/system/tenants/{tenantId}/projects/{projectId}/kept-repo` reads its state.

Turning the setting off erases nothing, and holds an unfinished erasure until it's on again. Each erasure done is recorded off the database too, beside the purge records (`KINDGI_TENANT_PURGE_RECORD`, under `kept-repos/erased/`), and `erasures replay --records` puts it back after a restore. The TypeScript client has `systemKeptRepos`. A runtime serving one tenant serves none of these.
