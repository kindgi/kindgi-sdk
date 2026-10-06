---
"@kindgi/cli": patch
---

`kindgi dev` keeps track of the providers it registered from `kindgi.config.ts` across restarts of the bundled Postgres. Its record of them (`.kindgi/dev/providers.json`) was keyed on the database's host port, which changes when the bundled Postgres's container comes back. After that, those providers read as someone else's: a change to one in the config wasn't applied ("registered already, not from kindgi.config.ts; left as it is"), and one removed from the config stayed registered. The record is now keyed on the project's database for the bundled Postgres, and on the runtime's origin with `--runtime-url`; a database you pass with `--database-url` is keyed as before. A record written by 0.1.3 is taken over on the next boot.
