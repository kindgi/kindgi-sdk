---
"@kindgi/cli": patch
"@kindgi/env-schema": patch
"@kindgi/api": patch
---

`kindgi dev` runs the runtime with a license key, as every Kindgi runtime does from 0.7.0. The free non-production key from https://access.kindgi.com covers development.

- `kindgi auth registry` keeps the license key it logged Docker in with for `kindgi dev`, in `~/.kindgi/license/license-key`: a file only you can read (`0600`), in a folder that holds nothing else (`0700`). A mirror's token isn't a license key, and isn't kept; `--check` keeps nothing. When your key renews, log in again with the new one.
- `kindgi dev` takes `KINDGI_LICENSE_KEY` from your shell, else that file. It gives the key to the runtime through Docker's own environment: never in `docker run`'s arguments, and never in the pack's `.kindgi/dev/runtime.env`, where a coding agent reads. With no key, it stops before anything starts and says where to get a free one, and a value that isn't a Kindgi license key is refused there too. A key that expires soon, or has expired, starts with a warning and the way to renew it. With `--runtime-url` it starts no runtime and asks for no key.
- `kindgi doctor`'s `license` check reads the key `kindgi auth registry` kept, too. With no key anywhere it fails, where it skipped before, and a kept key's renewal advice is a laptop's: sign in at access.kindgi.com, then `kindgi auth registry` again.
- `@kindgi/env-schema`: `KINDGI_LICENSE_KEY`'s description says the server requires it in development mode too, from 0.7.0.
- `@kindgi/api`: `GET /v1/license`'s `mode` describes `development` as a runtime before 0.7.0, which ran with no key. From 0.7.0 a development runtime has a key, and answers `licensed`. The field and its values don't change.
