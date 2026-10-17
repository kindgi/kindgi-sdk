---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/env-schema": patch
---

**A deployment can publish the IP addresses its calls to other sites come from, and `kindgi egress` prints them,** for a site that admits only known addresses. Publishing them changes nothing about where calls go or come from.
- **Settings:** `KINDGI_EGRESS_SERVER_ADDRESSES` (the server's own calls, such as to MCP servers and model providers, and its webhook deliveries) and `KINDGI_EGRESS_DEPLOYMENT_ADDRESSES` (calls made by deployed code), each a comma-separated list of IPv4 or IPv6 addresses. Unset: nothing is published.
- **`GET /v1/tenant`** gains an optional `egress: { server, deployments }`, the same for every tenant on the deployment, which any key of the tenant reads. It's absent when the deployment publishes none, and from a runtime before it. For runtimes: `createApp`'s optional `egress` (`EgressAddresses`), whose entries must be IP addresses.
- **`kindgi egress`** prints a CALLS / ADDRESS table, and says every tenant on the deployment shares the addresses, so a site keeps its own credentials too. `--json` prints both lists. With none published it says so, and exits 0.
- The TypeScript and Python clients' `Tenant` gains the optional `egress`.
