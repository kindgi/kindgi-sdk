---
"@kindgi/cli": patch
---

`kindgi tokens`, `kindgi service-accounts` and `kindgi people` manage who can act, and with which key. `tokens` was unwired.
- **`tokens create`:** an API key for you, or (as a tenant admin) for a person (`--for=user:<id>`) or a service account (`--for=sa:<id>`).
  - `--role=member|admin`, `--project=<id>` to limit it, `--expires=30d|12h|<iso-date>`, `--label` and `--capability`.
  - The secret is printed once, with a warning on stderr.
  - `tokens list` (`--for`, `--table`), `get` and `revoke`.
- **`service-accounts`:**
  - `create <name> [--tenant-admin] [--project=<id>:<role>]…`;
  - `list [--all]`, `get`;
  - `grant` and `ungrant` (`--tenant-admin`, or `--project` with `--role`);
  - `unregister`.
- **`people`:** `add --name [--email]` prints the new person's id. `list [--query]`, `get`.
