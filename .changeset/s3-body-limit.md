---
"@kindgi/api": patch
---

A request to the S3-compatible routes (`/s3/*`) carries at most `artifactMaxBytes` (default 100 MB), the limit an artifact upload has; more is S3's `400 EntityTooLarge`. A larger object goes up as a multipart upload, each part under the limit. A header-signed body is checked against its declared `x-amz-content-sha256` when it's empty too. `@kindgi/api` needs `hono` 4.13.8 or later.
