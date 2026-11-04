---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**A renewed license key can go to the running server, which checks it and runs it from then on.**

- `@kindgi/api`: `PUT /v1/license` (`license.replace`) hands the running server a key, sent as `{ "key": "kgi_lk_…" }`.
  - Only the deployment's operator can: with its own token, or with a system key holding `system:license`. System keys now reach this route too.
  - The server checks the key as it does at startup, and against the key it runs. It refuses a key for another licensee or another use, and an older key: one that expires earlier, or expires at the same time and was issued earlier.
  - Taken, it answers with the license, as `GET /v1/license` does.
  - Refused, it answers 409 `license-key-refused`. Its `reason` is one of `malformed`, `unknown-key`, `bad-signature`, `too-long`, `other-licensee`, `other-use` or `older`.
  - A server that binds no `replace` doesn't serve the route.
- `@kindgi/client`: `client.license.replace({ key })`.
- `@kindgi/cli`: `kindgi license renew --runtime` hands a new key to the runtime before writing it.
  - Taken: the key is written, and the runtime runs it now.
  - Refused: nothing is written. Renew exits 1 with the runtime's reason.
  - No answer, or a runtime that can't take a key (one before 0.7.0): the key is written, with a warning that the runtime uses it from its next start.
  - One exception: a key whose signing key needs runtime 0.7.0 or later, where the current key's doesn't. That key isn't written, and renew exits 1, because an older runtime would refuse it at its next start. No signing key needs 0.7.0 yet.
  - Without `--runtime`, renew writes the key as before.
