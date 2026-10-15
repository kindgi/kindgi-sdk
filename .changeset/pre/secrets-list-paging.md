---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/secrets-dotenv": patch
---

**`GET /v1/secrets` reads `includeRevoked`, and the `kindgi dev` secrets store pages.**
- `?includeRevoked=true` lists revoked secrets too, with `revokedAt` and `revokeReason`. It's metadata only, never a value. The route used to drop it, so `kindgi secrets list --include-revoked` and the TypeScript client's `secrets.list({ includeRevoked })` did nothing; now they reach the store. The operation documents the parameter, and the Python client's `secrets.list` gains `include_revoked`.
- `SecretBinding.list`'s contract says what a store returns: name order, at most `limit` records, and a `nextCursor` while more remain. `listVersions`' says the same, oldest first.
- `GET /v1/secrets` and `GET /v1/secrets/{name}/versions` answer `400 bad-input` to a `cursor` the store didn't issue, as the agents, flows, policies and eval-suites version lists do, so a client paging until done is never sent back to the first page. A store says which cursors it issued with `SecretBinding.issuedCursor` (optional: a store without it gets any cursor, as before); `@kindgi/secrets-dotenv` has it.
- `@kindgi/secrets-dotenv` pages by name: a `nextCursor` while more remain, and the next page starts after the page's last name, so a name added between pages neither repeats nor skips another. Before, it stopped at `limit`, and a 26th secret was out of reach.
