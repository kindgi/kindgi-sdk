---
"@kindgi/cli": patch
---

With `HOME` set but empty, `kindgi key create`, `export`, `list` and `trust` no longer use `.kindgi/keys/` under the current folder, where `create` wrote the private key, often into a pack's repository. They now refuse and say to set `HOME` or pass `--home <dir>`. `kindgi feedback submit`, `status` and `withdraw` refuse the same way, rather than keep their files under `.kindgi/feedback/` in the current folder.
