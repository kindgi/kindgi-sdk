---
"@kindgi/cli": patch
---

**`kindgi tenant get` and `kindgi tenant rename` read and rename your workspace,** through the client's `tenant.get` and `tenant.update`.
- **`get`** prints your workspace: its id, name and slug, and what the runtime adds.
- **`rename [--name=<name>] [--slug=<slug>]`** changes the name, the slug, or both, and prints the workspace. It's for tenant admins. The console's addresses carry the slug, so after a new one, links with the old one stop opening it. Nothing in the CLI uses the slug.
- **A `--slug`** is lowercase letters, digits and single hyphens, starting and ending with a letter or digit, at most 63 characters. Anything else, neither flag, or one given empty, is a usage error, exit 2, and nothing is sent.
- **Refusals name the server's code and exit 1:** `tenant-slug-taken`, `tenant-slug-in-config`, `tenant-closing`, `tenant-setup-pending`, `permission-denied`, `tenant-not-found`. Should the workspace not read back after the change, stderr says so, exit 0: the change went through.
