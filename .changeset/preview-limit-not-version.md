---
"@kindgi/api": patch
"@kindgi/cli": patch
---

**A preview release of the runtime stops starting 90 days after it was released, whatever its version.** `kindgi dev`'s warning, from 30 days before, now ends "A preview release stops starting 90 days after it was released." in place of "Preview releases stop starting 90 days after their release, until Kindgi 1.0." The description of `GET /v1/license`'s `preview` no longer says that a 1.0 or later release has none. The response itself is unchanged: `preview` is absent for a build from source, or with a production key.
