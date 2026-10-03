---
"@kindgi/api": patch
"@kindgi/adapter-model-gemini": patch
---

What a provider registration can make the server reach, for Gemini and for every provider's region.

- **`metadata.region` must be one DNS label** (lowercase letters, digits, hyphens; e.g. `us-central1`, `global`, `unspecified`). Anything else is `400 invalid-provider`, reason `invalid-region`. The Gemini adapter builds its hostname from the region (`https://<region>-aiplatform.googleapis.com/`), so `evil.example/x?` used to move the request to another host. With no `secret_ref`, that request carried the server's own Google credentials.
- **The Gemini adapter** checks its target itself: the location is one DNS label, and `adapter_config.project` is a Google Cloud project id or number, since it goes into the request path. This holds for `createGeminiProvider` too, not only the factory.
- **A Gemini `secret_ref` must be a service-account key** (`"type": "service_account"`), reduced to its key fields. Other credential types made the auth library fetch URLs the "key" named, with its headers, or read a file named in it. A key's `token_uri` or `universe_domain` could move the token exchange elsewhere. Google's own token endpoint is always used now.
