---
"@kindgi/env-schema": minor
---

What a server on Cloud Run needs to reach its pack service and images, and to take its keys without files:

- `KINDGI_PACK_SERVICE_AUTH`: `token` (default) | `google-id-token`, which also sends a Google ID token for an IAM-protected pack service.
- `KINDGI_IMAGE_REGISTRY_AUTH`: `static` (default, the username and password) | `google`, the server's own Google identity for Artifact Registry.
- `KINDGI_SECRETS_AAD_KEY` and `KINDGI_PUBLIC_TOKEN_SIGNING_KEY`: the key material itself, base64, as the alternative to the `_PATH` variables (one or the other, not both) for platforms that give secrets as environment variables. `KINDGI_SECRETS_AAD_KEY_PATH` is no longer required on its own: the postgres backend needs one of the two. `PUBLIC_TOKEN_KEY_VAR` names the new signing-key variable.
