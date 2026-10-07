---
"@kindgi/memory": patch
"@kindgi/api": patch
"@kindgi/authz": patch
"@kindgi/agents": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

Memory facts keep their id across revisions, and every read sees only what the caller may.

- **The scope guard.** A memory read gets `readers` (`MemoryReaders`): the projects, orgs, user, end user (`participantId`, new on `MemoryScope`) and conversations it may see. A binding applies them inside its query, before any limit; `isReadableBy` is the rule. On `/v1/memory`, the route works out the readers from the caller: a tenant admin reads everything; anyone else reads tenant-wide facts, the projects and orgs they may read, their own user facts, and every end user's and conversation's facts in the projects they may write. Writes are checked against the scope (`403 permission-denied`). An agent turn's retrievals see the run's project and org, the user it acts for, its conversation and that conversation's end user, never another conversation's or another end user's; `same-project` in a run without a project selects nothing.
- **Revisions.** `POST /v1/memory/facts/{factId}/supersede` writes the fact's next revision (same id, body `{ content, expectVersion?, … }`) and returns it; `DELETE /v1/memory/facts/{factId}` closes the current one; `POST …/verify` marks it verified; `GET …/revisions` lists them; `?version=` and `?asOf=` read the past. `409 fact-changed` (with `expectVersion`) and `409 legal-hold` refuse; a runtime without delete, verify or history answers `501 memory-operation-unsupported`.
- **Facts** carry `revisionId`, `trust`, `verifiedBy`/`verifiedAt`, `attributedTo` (from the writer), `generatedBy`, `subjects`, `validFrom`/`validUntil`/`observedAt`, `invalidatedAt`/`invalidatedBy`/`invalidationReason` and `review`, all optional.
- `AuthzCheckBinding.listObjects` (optional) lists the objects a principal may act on.
- Clients: `memory.facts.supersede`, `.delete` (now `DELETE`, returning the closed revision), `.verify`, `.revisions`, and `version`/`asOf` on `read`/`list`. CLI: `kindgi memory facts supersede|delete|verify|revisions`, `--revision` and `--as-of` on `get`, `--as-of` on `list`.
