---
"@kindgi/cli": patch
---

**`kindgi dev` replaces `.kindgirc.json` and `.kindgi/dev/runtime.env` with a new `0600` file each time, as `kindgi auth login` does `~/.kindgi/config.json`.** Both hold the dev runtime's tokens. Before, `kindgi dev` wrote into the file that was there, then set it to `0600`, so a program that had an older, looser one open could read the new tokens through it.
- **A symlinked one stays a link:** the file it points to is the one replaced.
- **A link to something that isn't a file, such as `/dev/null`, is left as it is,** for these two, for `~/.kindgi/config.json`, and for `kindgi feedback`'s files in `~/.kindgi/feedback/`: a new file renamed over it would take its place. For `.kindgirc.json`, `kindgi dev` then says it couldn't write it, and the banner names `.kindgi/dev/runtime.env` as where the token is.
- **On Windows,** these files are written in place, as before, and `kindgi feedback`'s files now are too.
