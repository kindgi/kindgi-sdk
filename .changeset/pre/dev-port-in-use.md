---
"@kindgi/cli": patch
---

`kindgi dev` checks the runtime's port before it starts anything. When `4000` is taken (another `kindgi dev`, in another worktree say), it takes the next free port and says so; `.kindgirc.json` records the URL, so clients follow. A `--port` that's taken is refused at once: "port 4301 is in use. Pick another with --port, or stop what's using it." Before, the boot created the database and bundled the pack, then failed on Docker's "port is already allocated".
