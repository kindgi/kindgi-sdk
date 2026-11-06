---
"@kindgi/cli": patch
---

With `HOME` set but empty, the CLI's home folder resolved under the current folder, often a pack's repository. Now:

- `kindgi key create`, `export`, `list` and `trust` refuse rather than use `.kindgi/keys/` there, where `create` wrote the private key. They say to set `HOME` or pass `--home <dir>`.
- `kindgi feedback submit`, `status` and `withdraw`, and `kindgi auth login`, refuse rather than keep their files under `.kindgi/` there, and say to set `HOME`.
- No command reads a home config file then.
- `kindgi dev` with its sandbox on refuses before the sandbox starts, since it keeps the home folder closed.
- `kindgi init` writes nothing into a repository root it can't tell apart from the home folder, and says so.
