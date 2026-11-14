---
"@kindgi/env-schema": patch
---

**Two settings for a server that scales to zero, which runtime 0.7.0 reads.** `KINDGI_TICK_CALLER` is the email of the service account whose Google-signed ID token the server's minute tick (`POST /internal/tick`) takes, and `KINDGI_SERVICE_URL` is the server's own URL, which the tick's token is for and where the server keeps a request to itself open while it has work in flight. Both or neither, for a server whose CPU is allocated only during requests (Cloud Run's request-based billing). The Cloud Run module's new `server_billing = "request"` sets both.
