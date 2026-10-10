---
"@kindgi/cli": patch
---

`kindgi doctor`'s Provider check asks the runtime about each registered provider (`GET /v1/providers/{id}/check`):
- **A registration the runtime can't build a provider from** is a warning, with each problem on its own line (`✗ <provider>: <path>: <message>`, and in `--json` the check's new `details`). It's a failure when no working provider is left.
- **The fix it gives:** unregister the provider, then register it again with the setting fixed. A registered id is taken, so registering it again without unregistering is refused. The default-model warning's fix now says the same.
- **A runtime without the route** (before 0.1.5): the check is skipped, as before.
