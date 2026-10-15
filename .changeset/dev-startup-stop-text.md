---
"@kindgi/cli": patch
---

**`kindgi dev` says why the runtime container stopped while starting as text, even when the runtime logs JSON.** The stopped container's log is read again for its last lines, and each record now reads as the line `kindgi dev` shows for it: a `boot` error record as `01:00:00.000 ERROR [boot] <its message>`, never the raw JSON. A record split between two chunks of the log is read whole, and lines that aren't records stay as they are.
