---
"@kindgi/cli": patch
---

**An unknown subcommand is an error, as an unknown command is.**
- **Before:** `kindgi agents register` (the subcommand is `publish`) printed the `kindgi agents` help and exited 0, so a script or a coding agent went on.
- **Now:** it exits 2, with the group's help on stderr after this line:
  `Unknown subcommand "register" for kindgi agents. Did you mean "publish"?`
- **The hint** names the group's subcommand a typo away (`lsit` → `list`), or the one another group spells this way (`register` → `publish`, `delete` → `unregister`). It never suggests the opposite of what was typed.
- **Unchanged:** a group with no subcommand, or only flags (`kindgi agents`, `kindgi agents --help`), still prints its help and exits 0.
