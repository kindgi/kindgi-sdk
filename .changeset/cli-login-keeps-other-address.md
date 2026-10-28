---
"@kindgi/cli": patch
---

**`kindgi auth login` keeps another address's login unless `--force`.** Before, logging in to a second runtime replaced the first one's address and API key in `~/.kindgi/config.json` without a word, and that key was gone. Now:
- **A login for another address** (or an API key with no address stored with it) is kept. `auth login` exits 2, names the login it keeps, and says how to have both: skip the login, and set `KINDGI_API_URL` and `KINDGI_API_TOKEN` to the other runtime's address and key in the shell you use it from.
- **`--force`** replaces it. The answer gains `replaced: { apiUrl }` (`null` for a key with no address), and a warning says whose key is no longer stored, under `--quiet` too.
- **As before:** a new key for the same address replaces the old one, and the same key saved under another name for its server is saved with nothing to force.

A script that logs in to one runtime after another in the same home needs `--force` now.
