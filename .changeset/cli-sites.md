---
'@kindgi/cli': patch
---

**`kindgi sites`: register a site that signs its own people in, and give it its one-time code, without writing code.** It's for tenant admins, and each command works on a site in the Default project, or in `--project`.
- **`kindgi sites register --name=<shown name> --origin=<https://…> --approvals-url=<url>`:** registers the site and prints its one-time code once, with where to paste it (Kindgi → Settings, in the WordPress plugin). Flags set the rest of its settings: `--allowed-role` (repeat it for each role), `--role-map`, `--reviewer-ceiling`, `--vouching=on|off`, `--people-cap` and `--new-people-per-day`.
- **`kindgi sites code <site-id>`:** gives a new one-time code, to connect the site again or to replace its key.
- **`kindgi sites list`, `get`, `update`, `pause`, `resume`, `revoke-key` and `unregister`:** the rest of a site's life, as `client.projects.sites` has it. `list --table` shows each site's state: signing in, not connected, not vouching, paused or unregistered.
