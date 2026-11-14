---
"@kindgi/cli": patch
---

`kindgi dev` hands `KINDGI_TENANT_EGRESS_PROXY` and `KINDGI_TENANT_EGRESS_NO_PROXY` to the runtime when they're set where it runs: each one that's set and not empty goes into `.kindgi/dev/runtime.env` as it is (the file stays mode `0600`), for a network that lets traffic out only through a forward proxy. `kindgi dev` never prints them. Runtimes before 0.7.0 ignore them.
