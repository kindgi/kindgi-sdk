---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**A key or session with limits manages only the keys within them.** A key or session limited to a project, or with the `member` role, now lists, reads and revokes only those of its owner's keys that are within its limits: the keys limited to the same project and, for the `member` role, the `member` keys. Those are the keys it could mint, itself among them. Before, it saw and could revoke every key of its owner, wider ones included.

`GET /v1/tokens` leaves the others out. `GET /v1/tokens/{tokenId}` and `POST /v1/tokens/{tokenId}/revoke` on one of them answer 403, naming only the caller's own limit: `key-project-mismatch` for a key not limited to the caller's project, `permission-denied` for an `admin` key and a `member` caller. Nothing about that key is in the answer. Someone else's key still reads as missing (404). A tenant admin, and a key or session without limits, see what they did before. `kindgi tokens list` says so in its help, and `tokens.list`, `tokens.get` and `tokens.revoke` in the client say so in their docs.
