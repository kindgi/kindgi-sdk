---
"@kindgi/cli": patch
---

The console is easy to find from the CLI:
- **`kindgi dev`'s ready block lists the console first**, with how to sign in: "Sign in as seeded user" on the sign-in page, which uses the dev token. The API's bare address used to come first, and answered 404. The `--no-watch` exit banner names the console too, and `--json` gives `consoleUrl`.
- **`kindgi dev --open`** opens the console in the browser once Kindgi is up. It can't be combined with `--no-watch`, because the runtime stops when the command exits.
- **`kindgi console`** opens the console of the runtime the CLI points at (`.kindgirc.json`, `--url`, `KINDGI_API_URL`), after checking that it serves one. `--no-open` only prints its URL, and `--json` gives `{url, opened, openError?}`. With no runtime configured, none answering, or no console served, it says so and exits 1.
- **`kindgi doctor`** names the console's URL in its Runtime check when the runtime serves one, and `--json` gives `consoleUrl`.
