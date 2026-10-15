---
"@kindgi/api": patch
"@kindgi/cli": patch
---

**`POST /v1/deployments` says why a registry read failed: `image-unverifiable` carries the registry binding's code in `details.cause`,** and, for an image past one of the server's bounds on reading an image, the bound in `details.limit`. Both are new, optional fields; a check that fails after a read that succeeded carries neither.
- `ImageRegistryError` has two more codes. `image-limit-exceeded` is an image past a bound the binding reads within, with `limit` (`ImageReadLimit`): `manifest`, `file`, `layer`, `read` or `unpack`, the image's own, so the same image is refused again, or `tenant-unpack-hour`, the tenant's reads in the last hour, which passes. `image-unreadable` is a layer that isn't an archive the binding can read: not a tar, or compressed twice. A binding that reported these as `image-registry-unreachable` can now tell them apart from a registry it couldn't reach.
- Before, the route's `cause` never reached the wire: `toWireError` keeps a domain error's `cause` off it. It still does; the route now builds these two refusals itself.
- `kindgi deploy` shows the cause, and its hint follows it: a registry it couldn't reach, credentials the registry refused, an unreadable layer, an image past a bound, or the tenant's hour of image reads.
- `kindgi deploy` now lists a refused deployment's `details.issues`. It read them from `error.issues`, where the server doesn't send them, so the list its hint promised never showed.
