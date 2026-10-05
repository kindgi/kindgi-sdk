---
"@kindgi/env-schema": patch
---

`KINDGI_WEBHOOK_PRIVATE_NETWORKS` (`allow` | `deny`, default `deny`): a self-hosted runtime's webhooks may go to a receiver on its own private network, at an RFC 1918, CGNAT (100.64.0.0/10) or IPv6 unique-local address. Loopback, link-local (the cloud metadata endpoints) and unroutable addresses stay refused, and webhooks stay https only. The runtime reads it from 0.1.3.
