---
"@kindgi/api": patch
---

S3 SigV4 verification now re-derives the signature from exactly what the client signed. Previously header-signed requests only verified when signing and verification fell in the same wall-clock second (the server re-signed with its own clock), and any header added after signing (proxies, the HTTP stack) broke verification; presigned URLs had no expiry check.

- Uses the client's `x-amz-date` / `X-Amz-Date`; rejects requests more than 15 minutes from the server clock (`RequestTimeTooSkewed`).
- Canonicalizes only the headers listed in `SignedHeaders`; requires `host`, `x-amz-date` and `x-amz-content-sha256` to be signed (header auth).
- Presigned URLs: enforces `X-Amz-Expires` (`AccessDenied: Request has expired`; at most 7 days, else `AuthorizationQueryParametersError`).
- `aws4` is no longer a runtime dependency.
