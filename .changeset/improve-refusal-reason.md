---
"@kindgi/api": patch
---

**A pass refused for having nothing to work on now says why in `details.reason`.** `POST /v1/proposals/improve` still answers `400 validation-failed`, with the same message, when the version has nothing for the pass to work on. Its `details` now also carry a `reason` that a client can match, rather than the message's words:
- `no-tunable-keys`: the version pins no settings block with keys marked `x-kindgi-tunable`.
- `no-pinned-prompt-block`: for a prompt pass, the version doesn't take its instructions from a pinned prompt block.

Older servers leave `reason` out.
