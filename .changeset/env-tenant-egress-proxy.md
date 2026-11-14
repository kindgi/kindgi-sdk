---
"@kindgi/env-schema": patch
---

`@kindgi/env-schema` gains `KINDGI_TENANT_EGRESS_PROXY` and `KINDGI_TENANT_EGRESS_NO_PROXY`, used from runtime 0.7.0. The first names a forward proxy for the connections whose host tenant configuration chose, and for webhooks, on a network that lets traffic out only through one. The runtime still refuses IP addresses and `localhost` by `KINDGI_TENANT_HOST_ACCESS`, and sends every other host to the proxy unresolved, by `CONNECT`, so the proxy must refuse at least what the level refuses. The second lists the hosts that skip the proxy. Neither one is `HTTPS_PROXY` or `NO_PROXY`. Unset, nothing changes.
