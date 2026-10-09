---
"@kindgi/api": patch
"@kindgi/client": patch
---

An Idempotency-Key is the caller's, and an answer that carries a secret isn't kept.
- **Per caller:** the idempotency cache key is the tenant, the caller (`user:…`, `service_account:…`, else the session, else the credential itself, as `token:` and 16 hex of its sha256), the route and the key. Someone else in the tenant who sends the same key and body runs the request themselves, and never gets another caller's answer. Keys stored before are simply not found again; they expire within 24 hours.
- **Secrets aren't kept:** a route whose answer carries a secret calls `withholdFromReplay(c)`. The middleware then keeps only that the request succeeded (status, when), never the answer. A retry with the same key and body gets `409 idempotency-key-replay-withheld`, with `status` and `at`, instead of the secret, and instead of running again, which would make a second one. The routes: `POST /v1/tokens`, `POST /v1/tokens/public`, `POST /v1/auth/callback/{providerId}`, `POST /v1/auth/refresh`, `POST /v1/auth/token-sign-in` (its session is in the cookie, which a stored answer never kept, so a repeat answered "signed in" with no session) and `POST /v1/webhook-endpoints/generate-secret`.
- **Stores:** `StoredIdempotencyEntry` gains optional `withheld` and `storedAt`. A store that doesn't keep `withheld` replays an empty body, so a store should add it; the in-memory one does.
- **Clients:** TypeScript and Python read the new code as a conflict.
- **Docs:** `env.put`'s description says env values aren't secret (a credential goes in `/v1/secrets`).
