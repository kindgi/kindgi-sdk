---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**One `kindgi dev` per pack.** A second `kindgi dev` in a pack used to take the first one's runtime container (both use the pack's container name), point `.kindgirc.json` at its own port, and leave the first without a runtime once it stopped. A coding agent starting `kindgi dev` beside yours did exactly that.

- **Now a second one refuses** before anything starts, exits with **code 3** ("kindgi dev is already running for this pack"), and says where the running one is: its pid, the console and the API. It says so too when that one's runtime has stopped answering, with how to stop it. With `--json`, it prints the same as `{ "running": { "pid", "since", "apiUrl", "consoleUrl", "answering" } }`.
- **How it knows:** the running one holds `.kindgi/dev/dev.lock`, taken with an exclusive create and removed on every way out. A lock whose process is gone (a crash, a `kill -9`) is taken over, with a note. A process counts as the same one only when its start time matches too, so a reused pid doesn't hold a dead one's lock.
- **The runtime container** is labeled with the `kindgi dev` that started it, and one still running for another live `kindgi dev` is never removed.
- `--reset` and `--recreate-services` are refused the same way while one runs.
- **The docs:** the getting-started skills (every language) and the coding agents page say so.
