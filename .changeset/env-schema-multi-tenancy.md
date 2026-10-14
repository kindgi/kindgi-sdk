---
"@kindgi/env-schema": patch
---

**The server settings say what a runtime serving many tenants starts with.**
- **`KINDGI_TENANCY`:** `multi` starts only with all of these: `KINDGI_TENANT_HOST_ACCESS=isolated`, `KINDGI_PACK_ROUTING=per-deployment` with `KINDGI_PACK_ENDPOINT_HOSTS`, `KINDGI_OPENFGA_API_URL` with `KINDGI_OPENFGA_PRESHARED_KEY`, `KINDGI_PRODUCTION_GATE=on` and `KINDGI_USAGE_METERING=on`. A start that lacks any is refused, naming each. Each of those settings says so too.
- **`KINDGI_PACK_ENDPOINT_HOSTS`:** unset, with `KINDGI_PACK_ROUTING=per-deployment`, the server refuses to start, since that routing needs `multi`. It used to say every endpoint is refused.
- **`KINDGI_PRODUCTION_GATE`, `KINDGI_PRODUCTION_NEXT_URL` and `KINDGI_USAGE_METERING`** say they're used from runtime 0.1.8 (earlier runtimes ignore them), and `KINDGI_TENANT_HOST_ACCESS` that `isolated` is (earlier runtimes refuse it at startup).
- **`KINDGI_ARTIFACT_MAX_BYTES`:** its default, 104857600 bytes, is 100 MiB, not 100 MB.
