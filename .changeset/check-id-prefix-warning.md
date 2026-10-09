---
"@kindgi/handler-runtime": patch
"@kindgi/cli": patch
---

The indexer warns when a pack's check id doesn't start with the pack's id (`<pack id>.`). Packs in one tenant share one space of check names, so the warning says to name the check `<pack id>.checks.<name>`. It's a warning, never a refusal: the pack builds and indexes as before. It covers a TypeScript guardrail's `check` (or any check its module exports) with an `id` and an `evaluate`, a Python `@guardrail`'s check id (`check_id=`, or the guardrail's own id), and a Java or Scala guardrail's (`checkId`, or its own id). A built-in named by its id isn't the pack's check, so it isn't flagged. The indexer report gains `warnings` (`IndexerWarning`, code `check-id-unprefixed`) beside `fileErrors`; `kindgi build` prints them after the index line, and `kindgi dev` at boot, then on a reload only the ones the last load didn't show (any still standing as one line).
