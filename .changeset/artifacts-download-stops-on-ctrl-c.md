---
"@kindgi/cli": patch
---

**One Ctrl+C stops `kindgi artifacts download`.** Before, the first Ctrl+C did nothing, and only a second one, a forced exit, stopped it, which could leave a half-written file behind. Now the first Ctrl+C (or SIGTERM) stops the download, whether it's still waiting for the server's answer or part way through the file. It removes the partial file, leaves the target as it was, says `kindgi artifacts download stopped: no file was written.`, and exits with code 130.
