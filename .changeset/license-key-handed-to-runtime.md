---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A renewed license key can be handed to a running server that takes one (`PUT /v1/license`). Runtime 0.7.0 doesn't serve that route, so it runs a renewed key from its next start.**

- `@kindgi/api`: `PUT /v1/license` (`license.replace`) hands the running server a key, sent as `{ "key": "kgi_lk_…" }`.
  - Only the deployment's operator can: with its own token, or with a system key holding `system:license`. System keys now reach this route too.
  - The server checks the key as it does at startup, and against the key it runs. It refuses a key for another licensee or another use, and an older key: one that expires earlier, or expires at the same time and was issued earlier.
  - Taken, it answers with the license, as `GET /v1/license` does.
  - Refused, it answers 409 `license-key-refused`. Its `reason` is one of `malformed`, `unknown-key`, `bad-signature`, `not-yet-valid`, `expired`, `other-licensee`, `other-use` or `older`.
  - A server that binds no `replace` doesn't serve the route. Runtime 0.7.0 binds none.
- `@kindgi/client`: `client.license.replace({ key })`.
- `@kindgi/cli`: `kindgi license renew --runtime` offers a new key to the runtime before writing it.
  - Taken: the key is written, and the runtime runs it now.
  - Refused: nothing is written. Renew exits 1 with the runtime's reason.
  - No answer, or a runtime that can't take a key, as runtime 0.7.0 can't: the key is written, with a warning that the runtime uses it from its next start.
  - One exception: a key whose signing key needs a later runtime than the current key's, 0.7.0 or later. That key isn't written, and renew exits 1, because an older runtime would refuse it at its next start. No signing key needs 0.7.0 yet.
  - Unchanged, where the runtime runs a key that expires earlier (it wasn't handed the key on the day it was written): the kept key goes to it, and nothing is written. Renew succeeds either way, with a warning when the runtime didn't take it. A runtime that runs the kept key, or a later one, is handed nothing.
  - Without `--runtime`, renew writes the key as before.
