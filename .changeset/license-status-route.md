---
"@kindgi/api": patch
"@kindgi/client": patch
---

`GET /v1/license`: where the deployment's license key stands, for any signed-in caller. The response has `mode` (`licensed`, or `development` under `KINDGI_DEV`), `name`, `use`, `expiresAt`, `daysLeft`, and `standing` (`valid`; `expiring` with 30 days or fewer left; `grace` once expired, while the runtime still starts with it). From 30 days before the key expires there's also `renew`: how to get the next key, as the startup banner says it. The key itself is never included. `createApp({ license })` takes a `LicenseStatusBinding` whose `status()` is read on each request; without one the route isn't mounted (404). The TypeScript client has `client.license.get()`, and the Python client gets the same method.
