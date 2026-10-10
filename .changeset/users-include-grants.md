---
"@kindgi/api": patch
"@kindgi/client": patch
---

The people list (`GET /v1/identity/users`) takes `include=grants`: each person carries `grants`, the same shape as `GET /v1/identity/users/{userId}/grants`, in one read instead of one per person. In TypeScript, `users.list({ includeGrants: true })` (and `identity.users.list`); in Python, `identity.users.list(include="grants")`. A runtime that doesn't read grants (no authorization store) lists the people without them. An unknown `include` value is a `400 bad-input`. The person-grants binding gains an optional `readMany`, so a runtime can read a page of people's grants in one call; without it, the route reads each person, a few at a time.
