---
'@kindgi/cli': patch
---

**`--hosted` works on every command, so a pack folder where `kindgi dev` ran can still reach Kindgi Cloud.** In that folder, `.kindgirc.json` points the CLI at the local dev runtime, and it wins over your `kindgi auth login`. Only `kindgi build` and `kindgi deploy` could skip it, so commands like `kindgi key trust`, `kindgi secrets set` and `kindgi auth whoami` went to the dev runtime instead of the Cloud.
- **One rule for every command:** a command is hosted when it's given `--hosted`, or when the env it acts in (`--env`, or `staging` for `kindgi build` and `kindgi deploy`) has `build: 'hosted'` in `kindgi.config.ts`. A hosted command goes to the CLI's own address (`--url`, `KINDGI_API_URL` or the one `kindgi auth login` stored), with that address's key, and never reads a dev runtime's `.kindgirc.json`. With no own address it's refused, and the refusal says the file isn't read.
- **A line first when a command goes to the dev runtime and another address is in reach:** `kindgi key trust goes to the kindgi dev runtime at http://127.0.0.1:4000 (…/.kindgirc.json says so). For https://platform.kindgi.com, pass --hosted.` When the key was given with `--token` or `KINDGI_API_TOKEN` and nothing else is signed in, the line says to name that key's address with `--url` or `KINDGI_API_URL`. There's no line when `--url` or `KINDGI_API_URL` named the address, or when the dev runtime is the only one in reach.
- **`kindgi dev --hosted` is refused** (exit 2): a dev runtime is never hosted. Other commands that don't call the API ignore the flag, as they do `--url`.
- `--hosted` is listed with the global flags now. For `kindgi build` and `kindgi deploy` it means what it did: the hosted build service, and for a deploy, waiting for the pack service.
