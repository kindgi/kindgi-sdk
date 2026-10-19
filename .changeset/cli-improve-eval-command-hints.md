---
"@kindgi/cli": patch
---

**`kindgi improve` and `kindgi eval` now point to the real command.** A command that reads naturally but isn't one — `kindgi improve`, `kindgi eval` — used to print only "Unknown command" and the root help. It now names the command that was meant: `kindgi improve` → `kindgi proposals improve`, and `kindgi eval` → `kindgi eval-runs` or `kindgi eval-suites`. Any other unknown command prints the root help as before, with the unknown word quoted. This also fixes a crash: an unknown command or subcommand that happened to name a JavaScript object-prototype member (such as `constructor`) printed a `TypeError` instead of the usual message.
