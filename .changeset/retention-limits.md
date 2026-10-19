---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A server can limit how long a retention policy keeps a domain's records.**
- `createApp` takes `retentionLimits`: per domain, the most seconds a policy may keep its records (a whole number, 1 or more). A `*` key, an unknown domain, or a limit that isn't a whole number of seconds fails at `createApp`, naming it.
- `POST /v1/policies` refuses a `retention` policy for a limited domain whose `graceSeconds` is over the limit, or `-1`, with `400 retention-over-limit` and a message that names the limit: "`graceSeconds` 31536000 (365 days) is over the retention limit for `run` rows, 90 days." (`details`: `domain`, `graceSeconds`, `limitSeconds`). Reinstating a retired version over the limit is refused the same way, and the version stays retired. A `*` policy isn't refused, and a domain with no limit takes any grace, as before.
- `GET /v1/retention/scheduled`: an item the limit decides has `limitApplied: true`. When no policy covers its domain it has no `policyId` or `policyVersion`, so both are now optional on `RetentionScheduledItem`. `POST /v1/retention/sweep`'s per-domain result can say `limitApplied: true` too. A server with no limit sends what it sent before.
- The error reference has an entry for `retention-over-limit`, and the retention page says what a limit does.
