---
"@kindgi/cli": patch
---

**`kindgi dev` takes a database URL with a list of hosts (`postgres://<user>:<password>@h1:5432,h2:5432/<database>`) on macOS, on Windows and under Docker Desktop, and reaches each local host in it from the runtime's container.** A local host in libpq's `?host=` is reached the same way. Before, a list with ports stopped `kindgi dev` with `Invalid URL`, and in a list without ports a local host was missed, or the hosts after it were dropped.
