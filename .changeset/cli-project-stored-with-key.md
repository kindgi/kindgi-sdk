---
"@kindgi/cli": patch
---

**A project can be stored with the key.** A `project` field (an id or a slug) in the config file that holds the key, `~/.kindgi/config.json` or a folder's `.kindgirc.json`, is where a command that names no project goes: `kindgi deploy` (after `--project` and the env block's `project`), and the commands that would otherwise take the workspace's default project (`agents publish`, `flows publish`, `guardrails register`, `tools publish`, `sites`, `connection-choices`, `expert-queue` and `queue-rules`). `--project` comes first. The project goes with that key only: a key given with `--token` or `KINDGI_API_TOKEN` has none, and `kindgi auth login` with another key or address removes it, with a warning. `kindgi deploy` names the project it took and the file it came from. Without the field, nothing changes.
