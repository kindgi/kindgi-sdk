---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A provider or MCP endpoint registration can opt in to receive the run's `traceparent`.** It's off by default: nothing about a run's trace leaves the deployment unless a registration turns it on.
- **Providers:** `send_traceparent: true` on `POST /v1/providers`. A runtime then sends each model call's `traceparent` to the provider as a request header: ids only, never content.
  - Any other value is refused with `422 provider-config-invalid` at `details.issues` `/send_traceparent`, listed before the adapter's own issues.
  - `ProviderRegisterInput` and `ProviderRuntimeEntry` gain `sendTraceparent`.
- **MCP endpoints:** `sendTraceparent: true` on `POST /v1/mcp/endpoints`, for HTTP transports, and reads return it.
  - A non-boolean, or `true` on a `stdio` endpoint, is refused with `400 invalid-mcp-endpoint`, reason `invalid-send-traceparent`.
- **The runtime enforces it,** not the adapters. An older runtime ignores the field and sends nothing.
