---
"@kindgi/cli": patch
---

**`kindgi dev`'s banners no longer print the dev token in full.** The `Token` line of the "Kindgi is up" block, and `--no-watch`'s `Bearer token` line, show it as the runtime's own startup line does: `kgi_bt_…` and its last four characters. So a dev log someone pastes doesn't give a working token away.
- **Each line says where the full token is:** the pack's `.kindgirc.json`, readable only by you and in the `.gitignore` that `kindgi init` writes, which the CLI's other commands in the pack's folder already read. If that file can't be written, the line names `.kindgi/dev/runtime.env` instead.
- **A token pinned with `--dev-token` in another shape** shows only its last four characters, and none when it's under 16 characters.
