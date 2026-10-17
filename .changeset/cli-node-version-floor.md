---
"@kindgi/cli": patch
---

**On a Node older than 22.12, `kindgi` stops with one line that says what to do, and exits 1:** `Kindgi needs Node 22.12.0 or later; this is Node 20.11.0. Install or switch to it (nvm install 22, or https://nodejs.org), then run the command again.` The check runs before the rest of the CLI loads. Before, the CLI went on loading, and Node printed its own warnings (such as `ExperimentalWarning: Importing JSON modules`) without saying what was wrong.
