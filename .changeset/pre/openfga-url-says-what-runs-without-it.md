---
"@kindgi/env-schema": patch
---

`KINDGI_OPENFGA_API_URL`'s description says what a runtime without it does, instead of saying production must set it. No roles are checked: every key and every sign-in works in every project, and only the tenant admin (the API token or an `admin` key) changes tenant settings. That suits one tenant whose people trust each other. `KINDGI_TENANCY=multi` refuses to start without it.
