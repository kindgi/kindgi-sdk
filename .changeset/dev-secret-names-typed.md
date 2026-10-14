---
"@kindgi/api": patch
"@kindgi/secrets-dotenv": patch
"@kindgi/cli": patch
---

**A secret name the store can't write is the caller's `400`, saying the store's rule, never a `500`.**
- **Under `kindgi dev`,** a secret is a key in your env files, so a name Kindgi writes is capital letters, digits and underscores, not starting with a digit.
  - Any other name (`acme-woo-orders`) is refused with `400 secret-name-invalid`, and the message offers a name that works (`ACME_WOO_ORDERS`). So is a `KINDGI_*` name.
  - A `kindgi.` name is refused with `400 reserved-name-prefix`.
  - These used to answer `500 secret-store-error`.
  - This applies to `POST /v1/secrets`, `PATCH /v1/tenant/config` and `POST /v1/webhooks` with `generateSecret`.
- **`POST /v1/webhooks` with `generateSecret` refuses such a name before anything is stored.** No trigger is registered and then taken back.
- **A name typed into `.env` by hand still resolves,** even one Kindgi wouldn't write (`acme-woo-orders=…`). A webhook trigger may still name it, and `PATCH /v1/webhooks/{triggerId}` may switch to it.
- **`PATCH /v1/tenant/config` answers a refused secret write at its code's status,** as `POST /v1/secrets` does. That's a `400` for a name or value the store can't write, or a `429`, `502` or `503` when the store's external provider limits the runtime, refuses its credentials or can't be reached. It answered `500` for every code.
- **The API reference lists those `429`, `502` and `503` answers** for both operations.
- **`SecretBinding.nameRefusal(name)` is a new optional method.** It's how a store says which names it can't write, and `set` refuses those names with the same code. `observeSecretWrites` and `guardProviderKeys` pass it through.
- **`kindgi webhooks register --secret` now says the rule that applies under `kindgi dev`.**
