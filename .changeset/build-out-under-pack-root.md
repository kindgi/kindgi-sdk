---
"@kindgi/cli": patch
---

**`kindgi build` refuses an `--out` that resolves outside the pack root, with a message that says what to do instead.** The build output's local indexer and the pack image both resolve the pack's dependencies by walking up from the output directory into the pack, so output outside the pack root would fail mid-build. The check follows symlinks, so an in-pack symlink can't point the output outside the pack either. The default (`.kindgi/build` under the pack root) and any path inside the pack are unaffected.
