---
"@kindgi/cli": patch
---

**Pin a flow's or a tool's version from the CLI.** `kindgi flows` and `kindgi tools` each gain five commands over the pin routes, as `kindgi agents` has for agents:

- `pinned <id> [--project=<id>] [--org=<id>]`: the version in use there, and why (`pinned`, with its scope, or `latest`). For a flow, it's the version a run that names none uses. For a tool, it's the version the next agent or flow version published there locks.
- `pinned-versions <id>`: every scope with a pin, with its version and when and by whom it was set (`--table`).
- `pin <id> <version> (--tenant | --org=<id> | --project=<id>) [--reason=<text>]`: pins the version in that scope, or moves the scope's pin to it.
- `unpin <id> (--tenant | --org=<id> | --project=<id>) [--reason=<text>]`: removes the scope's own pin.
- `pin-history <id> [--limit=<n>] [--cursor=<c>]`: every pin and unpin, newest first.

Flows and tools pin per project, org or tenant, so there is no `--segment`, and there's no release gate. Both writes take `--idempotency-key`. What the API refuses is printed as it says it: a catalog tool or one the runtime ships (`tool-not-pinnable`), a tool pin in a later environment of an order (`environment-takes-promotions`), and a tenant- or org-wide pin of an item in an environment order (`pin-scope-spans-environments`). `kindgi runs start --flow-version` now says that, when it's left out, the run uses the version pinned for its project, its org or the tenant, else the latest.
