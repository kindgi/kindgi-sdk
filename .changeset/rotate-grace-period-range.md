---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A rotation's grace period is a whole number of milliseconds from 0 to 365 days.**
- `POST /v1/secrets/{name}/rotate` answers `400 bad-input` for a `revokeOldAfterMs` outside that range: a negative number, a fraction, or more than 31536000000 (365 days). The message names the range. Before, it checked only that the value was a number: a negative one was taken and did nothing, and one of hundreds of thousands of years made the store fail. The field shipped without an upper bound, so the accepted range is now 0 to 365 days; the schema says so with a `maximum`.
- `kindgi secrets rotate --revoke-old-after` refuses such a value before sending anything, in the same words, and exits 2.
- The schema says what a version's `revokedAt` and a rotation's `oldVersionRevokedAt` mean: a time still to come is the old version's grace period, and it still resolves until then. `MAX_REVOKE_OLD_AFTER_MS` is exported from `@kindgi/api`.
