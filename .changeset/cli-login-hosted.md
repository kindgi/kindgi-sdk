---
"@kindgi/cli": patch
---

**`kindgi auth login --hosted` signs in to Kindgi Cloud, and login asks for the key on a terminal.**
- `--hosted` on `kindgi auth login` saves Kindgi Cloud's address, `https://platform.kindgi.com`, as the CLI's own, so commands go there from then on, `--hosted` ones among them. A `--url` for another address beside it is refused (exit 2). With `--profile <name>` it's saved as that profile: `kindgi auth login --hosted --profile cloud`.
- Given no key (`--token-stdin`, `--token`, or `KINDGI_API_TOKEN` without a profile), login asks for one, hidden, when stdin is a terminal: `API key for <url>: `. Ctrl+C cancels and an empty key is refused, and neither saves anything. Without a terminal, login never asks: it saves the key stored for that address, or it's refused for having none.
- A hosted command with no API address names `kindgi auth login --hosted` for Kindgi Cloud. So do login's refusal for no address, and its refusal to replace another address's login when `--hosted` named Kindgi Cloud.
