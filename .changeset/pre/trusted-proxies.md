---
"@kindgi/env-schema": patch
"@kindgi/api": patch
---

New runtime setting `KINDGI_TRUSTED_PROXIES`: which proxies in front of the runtime to trust for a client's address, used by rate limits and audit records. Unset, the address is the connection's peer and `X-Forwarded-For` is ignored. Behind a load balancer or ingress, set a hop count (`1`) or your proxies' IPs/CIDR ranges. The client is then the first `X-Forwarded-For` hop from the right that isn't a trusted proxy, never the leftmost on its own. The sign-in options rate limit no longer keys on the leftmost `X-Forwarded-For` address, which a client can spoof: by default it uses the nearest hop.
