---
"@kindgi/env-schema": patch
---

**Two server settings for an OpenFGA that requires its callers to prove themselves.**
- **`KINDGI_OPENFGA_PRESHARED_KEY`:** OpenFGA's preshared key (`--authn-method=preshared`), sent with every call as `Authorization: Bearer <key>`. It needs `KINDGI_OPENFGA_API_URL`, and is set by reference to a secret. The description says how to rotate it with no refusal: add the new key to OpenFGA's list, point the server at it, then drop the old one.
- **`KINDGI_OPENFGA_AUTH`:** `none` (default) or `google-id-token`, which also sends a Google ID token from the server's own identity, for an OpenFGA on Cloud Run behind IAM. The token goes in `X-Serverless-Authorization`, since `Authorization` carries the key.
