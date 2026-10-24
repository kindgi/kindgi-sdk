---
"@kindgi/cli": patch
---

**`kindgi build` prints each line as it happens.** Until now it printed nothing until the build was over.
- **The build server's log** streams as the server sends it, and so does Docker's log for `--local`.
- **A build that fails** keeps what it printed, the build server's log included, and the error comes after it. Until now, a build server's build that failed printed only the error.
- **`--quiet`** prints only an error.
- **The summary** still goes to stdout at the end, so `--json` output stays apart from the progress on stderr.
