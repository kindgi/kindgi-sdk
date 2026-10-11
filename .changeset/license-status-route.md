---
"@kindgi/api": patch
"@kindgi/client": patch
---

`GET /v1/license`: where the deployment's license key stands. The response has `mode` (`licensed`, or `development` under `KINDGI_DEV`), `name`, `use`, `expiresAt`, `startsUntil` (until when the runtime still starts with the key), `daysLeft`, `standing` (`valid`; `expiring` with 30 days or fewer left; `grace` once expired, while the runtime still starts with it; `expired` after that) and `renewBy` (`command`, a key the deployment renews with `kindgi license renew`; `contact`, a key Kindgi issued). From 30 days before the key expires there's also `renew`: how to get the next key, as the startup banner says it, with where the deployment keeps its key and renewer. The key itself is never included.

The license is the deployment's, not a tenant's. The deployment's own token reads all of it. Where the deployment serves exactly one tenant, that tenant's admins read the countdown only (`mode`, `standing`, `expiresAt`, `startsUntil`, `daysLeft`, `renewBy`), never whose key it is or where it's kept. Anyone else gets `403 license-operator-only`, recorded as an access decision. `createApp({ license })` takes a `LicenseStatusBinding`: `status()` is read on each request, and `soleTenant()` names the one tenant the deployment serves, or `null`. Without `soleTenant`, only the deployment's own token reads the license. Without a binding, the route isn't mounted (404). The TypeScript client has `client.license.get()`, and the Python client gets the same method.
