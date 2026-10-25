---
"@kindgi/cli": patch
---

**`--quiet` leaves out every command's success notes, and keeps its warnings.** About twenty commands still printed what they'd done under `--quiet`: `secrets set`/`rotate`/`revoke`/`pull`/`copy`, `env`, `key`, `init`, `mcp`, `webhooks`, `sites`, `upgrade`, `adapters prepare`, `auth registry`, `feedback write`, and the note after Ctrl+C stops `runs start` or `connections connect` waiting. They now print only their errors and warnings, as `--quiet` says. Some warnings had been left out under `--quiet`, and they now show:
- a failed `kindgi runs start` run's warnings and its error;
- `kindgi dev`'s `--reset` that couldn't remove `.kindgirc.json`, a pack service port that was taken, and `--open` that couldn't open a browser, or found no console to open. With or without `--quiet`, these now start with ⚠;
- a `.kindgirc.json` that `kindgi dev` couldn't write, or couldn't make readable by its owner only. Each now has a warning of its own, with or without `--quiet`.

**What's shown only once prints alone on stdout under `--quiet`,** as `kindgi connections connect`'s link does: `kindgi tokens create`'s secret, `kindgi webhooks register`'s signing secret, and the one-time code from `kindgi sites register` and `kindgi sites code`. Before, `kindgi tokens create --quiet` printed the key's secret nowhere. Without `--quiet`, these commands print as before.
