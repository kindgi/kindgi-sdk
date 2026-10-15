---
"@kindgi/api": patch
"@kindgi/secrets-dotenv": patch
---

**A secret value the store can't hold is the caller's `400`, saying why, never a `500`.**
- **Under `kindgi dev`,** a secret is a key in your env files. No env-file quoting holds a value that has a double quote, or a backslash followed by `n` or `r`, together with a carriage return or with both a single quote and a backtick.
  - Such a value is refused with `400 secret-value-invalid`, the new code, before any file is read. It used to answer `500 secret-store-error`.
  - The message says why and never repeats the value.
  - This applies to `POST /v1/secrets`, `PATCH /v1/tenant/config` and `POST /v1/deployments/{deploymentId}/secrets`.
- **`SecretError` gains the codes a store's `set` refuses with:** `reserved-name-prefix`, `secret-name-invalid`, `secret-value-too-large` and `secret-value-invalid`. A store that rotates by setting a new version can answer a rotation's new value as it answers the write, and `POST /v1/secrets/{name}/rotate` answers any of them it gets at `400`.
- **The API reference:**
  - lists `secret-value-invalid` beside the other refusals for those three operations;
  - gives `POST /v1/secrets/{name}/rotate` its `400` (`secret-value-too-large`, `reserved-name-prefix`);
  - lists the `429`, `502` and `503` an external provider answers for the rotation and the deployment sync, as it already did for the other two.
