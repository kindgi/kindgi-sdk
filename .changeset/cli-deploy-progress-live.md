---
"@kindgi/cli": patch
---

**`kindgi deploy` prints each line as it happens.** Until now it printed nothing until it was over, through an inline `kindgi build` and the wait for a hosted pack service.
- **The inline build's lines** go out between deploy's, the build server's log among them, as `kindgi build` prints them.
- **A deploy that fails** keeps what it printed, and the error comes after it. Until now, a deploy that stopped before it was sent printed only the error.
- **`--quiet`** leaves the inline build's lines out, as for `kindgi build`. Deploy's own lines still show: a refused deployment's error is among them.
- **The summary** still goes to stdout at the end, so `--json` output stays apart from the progress on stderr.
