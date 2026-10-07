---
"@kindgi/api": patch
"@kindgi/secrets-dotenv": patch
---

Rotating or revoking a secret under `kindgi dev` (the env-file store) answered `500 secret-store-error`, which reads as "the server broke, try again". The store doesn't do either by design, so it's now `501 secret-operation-unsupported`. The message says what to do instead: edit the value in the env files, or remove the name there. `SecretError` gains the code.
