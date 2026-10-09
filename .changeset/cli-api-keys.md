---
"@kindgi/cli": patch
---

`kindgi tokens`, `kindgi service-accounts` and `kindgi people` manage who can act, and with which key. `tokens` was unwired.
- **`tokens create`:** an API key for you, or (as a tenant admin) for a person (`--for=user:<id>`) or a service account (`--for=sa:<id>`).
  - `--role=member|admin`, `--project=<id>` to limit it, `--expires=30d|12h|<iso-date>`, `--label` and `--capability`.
  - The secret is printed once, with a warning on stderr.
  - `tokens list` (`--for`, `--table`), `get` and `revoke`.
- **`service-accounts`:**
  - `create <name> [--tenant-admin] [--tenant-member] [--project=<id>:<role>]…`;
  - `list [--all]`, `get`;
  - `grant` and `ungrant` (`--tenant-admin`, `--tenant-member`, or `--project` with `--role`);
  - a service account reads the tenant's settings only with `--tenant-member`: give it only what its job needs;
  - `unregister`.
- **`people`:** `add --name [--email]` prints the new person's id, and says on stderr what being added gives them: they can read the tenant's settings, and need a project role to work. `list [--query]`, `get`.
