---
"@kindgi/api": minor
"@kindgi/client": minor
---

API keys are service accounts with a role and capabilities, and they can be listed.

- **`@kindgi/api`:**
  - `POST /v1/tokens` takes `role` (`admin` | `member`, default `member`) and `capabilities`.
    - Only a tenant admin can mint (`admin` on the tenant with authorization on, otherwise the `tenant-admin` scope), and only capabilities the caller holds can be granted.
    - The response is the key's record plus its `token`, shown once.
  - New `GET /v1/tokens` (paged, newest first) and `GET /v1/tokens/{tokenId}`. They're tenant-admin only and never return secrets. Revoke is tenant-admin only too.
  - `TokenAdmin` gains `list` and `get`. `mint` takes `role`, `capabilities` and `createdBy`, and returns `{ record, token }`. New types: `ApiTokenRecord`, `ApiTokenRole`, `API_TOKEN_ROLES`.
  - `TokenResolution.tokenId` is a durable key's id. The principal is then `service_account:<tokenId>`, and it wins over a session id.
- **`@kindgi/client`:**
  - `tokens.create(spec?)` sends `role`, `capabilities`, `label`, `expiresAt` and `projectId`, and returns the server's record. `ApiTokenSpec` and `ApiToken` drop `name`/`scopes` for `label`/`role`/`capabilities`.
  - `tokens.list({ limit, cursor })` and `tokens.get(id)` are wired.
  - The unwired `tokens.scopes()` and `TokenScope` are gone.
