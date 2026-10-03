---
"@kindgi/handler-runtime": patch
"@kindgi/pack-conformance": minor
"@kindgi/specs": minor
---

A pack's code no longer sees the pack service's token.

- **Fix (`@kindgi/handler-runtime`, and the Python SDK's `kindgi.pack.serve`):** the pack service reads `KINDGI_PACK_SERVICE_TOKEN`, then removes it from its process environment before it loads the pack's code. Before, a tool, or any dependency it imported, could read the token. Whoever holds the token can call the pack's tools directly, without going through the runtime.
- **`@kindgi/specs`:** `pack-protocol.schema.json` 2.1.0 adds this to the process contract, which every pack service follows. The Python SDK's vendored copy matches.
- **`@kindgi/pack-conformance`:** a new fixture tool, `conformance.process-env`, returns the `KINDGI_` variables its process can see. The new case "pack code doesn't see the service token" checks it, in every implementation.
