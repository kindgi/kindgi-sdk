---
"@kindgi/cli": patch
---

**`kindgi dev` no longer takes over a providers record written by 0.1.3.** 0.1.3 keyed the bundled Postgres's entries in `.kindgi/dev/providers.json` on its port, which changes when its container comes back, and from 0.1.4 the first boot moved them to a key that names the project's database, not its port. A record still from 0.1.3 is now left as it is: a provider it registered reads "registered already, not from kindgi.config.ts", and `kindgi providers unregister <id>`, then a restart, makes it the pack's own again.
