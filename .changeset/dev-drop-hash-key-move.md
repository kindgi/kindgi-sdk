---
"@kindgi/cli": patch
---

**`kindgi dev` no longer moves a providers record keyed on a hash of the database URL.** Before 0.6.0, a database URL with a list of hosts and ports, or libpq's socket form, keyed its entries in `.kindgi/dev/providers.json` on a hash of the whole URL, password included. 0.6.0 keys them on the URL's hosts, ports and database, and each boot moved the hash-keyed entries and then deleted every key of that shape. A record still keyed on a hash is now left as it is: a provider it registered reads "registered already, not from kindgi.config.ts", and `kindgi providers unregister <id>`, then a restart, makes it the pack's own again.
