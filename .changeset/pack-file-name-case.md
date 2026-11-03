---
"@kindgi/cli": patch
---

**`kindgi build` refuses a block file or template named in another case than the disk has.** On a disk that ignores case (macOS, Windows), `"templateFile": "Reply.liquid"` finds `reply.liquid`, and a blocks pattern's `blocks/` finds a `Blocks/` folder, so the pack indexes and runs under `kindgi dev`; a build on Linux, as in CI, doesn't find the file. The build now names each such template, and a pattern whose folder is in another case, as the pack names it and as the disk spells it. `kindgi dev` says the same once at boot or on the reload that brings it, and still loads the block.
