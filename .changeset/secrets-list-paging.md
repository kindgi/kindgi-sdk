---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/secrets-dotenv": patch
---

**`GET /v1/secrets` reads `includeRevoked`, and the `kindgi dev` secrets store pages.**
- `?includeRevoked=true` lists revoked secrets too, with `revokedAt` and `revokeReason`. It's metadata only, never a value. The route used to drop it, so `kindgi secrets list --include-revoked` and the TypeScript client's `secrets.list({ includeRevoked })` did nothing; now they reach the store. The operation documents the parameter, and the Python client's `secrets.list` gains `include_revoked`.
- `SecretBinding.list`'s contract says what a store returns: name order, at most `limit` records, and a `nextCursor` while more remain.
- `@kindgi/secrets-dotenv` pages by name: a `nextCursor` while more remain, and the next page starts after the page's last name, so a name added between pages neither repeats nor skips another. Before, it stopped at `limit`, and a 26th secret was out of reach.
