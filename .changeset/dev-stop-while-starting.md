---
"@kindgi/cli": patch
---

**`kindgi dev` stops at once when you press Ctrl+C (or send SIGTERM) while it waits for the runtime.**

Before, the wait for the runtime never looked at the stop. That covers the wait at `--runtime-url` (up to 10 minutes) and the wait for the runtime container to start serving. A single Ctrl+C was then ignored until the wait ended, and only a second signal, or SIGKILL, stopped it.

Now it stops at once, prints `kindgi dev stopped before the Kindgi runtime served.`, and exits with 130. A runtime container it was starting is removed right away, since it hadn't served anything. Stopping a running session is unchanged.
