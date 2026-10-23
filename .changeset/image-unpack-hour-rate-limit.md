---
"@kindgi/api": patch
"@kindgi/cli": patch
---

**`POST /v1/deployments` answers a deploy refused by the tenant's hour of image reads as the rate limit it is: `429 rate-limit-exceeded` with `Retry-After` and `details.limit: "tenant-unpack-hour"`,** where it answered `400 image-unverifiable` with the wait only in its message. The hour passes, so it's waited out as the server's other limits are: `kindgi deploy` waits and sends the same request again (up to 10 minutes in all), and the clients map it to their `rate-limited` error with the wait.
- `ImageRegistryError`'s `image-limit-exceeded` has an optional `retryAfterMs`: for `tenant-unpack-hour`, how long until the tenant's hour has room again. The route sends it as `Retry-After`; a binding that gives none gets the whole hour.
- The image's own bounds (`manifest`, `file`, `layer`, `read` and `unpack`) stay `400 image-unverifiable`: the same image is refused again.
- `kindgi deploy`'s hint for the tenant's hour now follows the `429`, shown when the wait is longer than the command waits.
