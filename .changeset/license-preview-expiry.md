---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A preview build's own expiry on `GET /v1/license`.** From the 0.1.8 runtime until Kindgi 1.0, a runtime release stops starting 90 days after it was released, in every mode, unless a production key exempts it. Earlier releases don't expire.
- **`LicenseStatus.preview`** (optional, schema `LicensePreview`) carries `version`, `releasedAt`, `expiresAt`, `daysLeft` and `standing` (`valid`, `expiring` from 30 days before, `expired`). It's absent when nothing expires: a 1.0 or later release, a build from source, or a production key.
- **Both views include it,** the deployment's own token and a sole tenant's admins: it's the build's, not the key's. A runtime that doesn't report it answers as before.
- **`kindgi dev` warns** from 30 days before, with the way to a newer runtime: update the CLI (for the runtime it pins), or run a newer image or release (`--runtime-image`, `--runtime-url`).
- The Python client gains `LicensePreview`.
