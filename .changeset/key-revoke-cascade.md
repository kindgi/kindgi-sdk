---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**A key can't outlive the key that makes it.** When an admin's key is revoked, or the admin is removed, keys they made with it from the command line stop too, pipelines' keys included. Keys made from the console's SSO, social or emailed-link sign-in, or with the deployment's token, don't.

- `POST /v1/tokens` passes the store the key a new key is minted with (`TokenMintInput.mintedWith`): the caller's key, or the key a token sign-in session was opened with. A session from any other sign-in, and the deployment's token, pass none. A key carries it as `mintedWith` (`ApiTokenRecord`, `ApiToken`). A store hands back a new key revoked when that key turns out revoked as it mints.
- Revoking a key revokes every key minted with it, and with those in turn, whoever they act for, and ends their sessions. `POST /v1/tokens/{tokenId}/revoke` answers `alsoRevoked`, oldest first (`TokenRevokeOutcome`), and `client.tokens.revoke` resolves to `{ id, alsoRevoked }` (`TokenRevoked`). Revoking a revoked key revokes any key minted with it that isn't revoked yet.
- `GET /v1/tokens?mintedWith=<tokenId>` (`client.tokens.list({ mintedWith })`) lists the keys minted with a key, to any depth, within what the caller sees. Each page says `mintedWith`; an older runtime ignores the filter, and its page doesn't.
- Removing a person counts the keys minted with theirs apart, as `mintedKeysRevoked` (`IdentityUnregisterUserResult`, `UnregisterUserResult`).
- `kindgi tokens revoke` says how many keys went with it, and `kindgi people remove` how many were minted with theirs.
- Every new field is optional. A store that doesn't record which key minted which leaves them out, and a key minted before a store recorded it stands alone.
