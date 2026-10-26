---
"@kindgi/cli": patch
---

**`kindgi key create <id> --env <name> --home <dir>`'s note names the key file it wrote.** Before, the `signingKey` line to add was always `'~/.kindgi/keys/<id>.pem'`. `kindgi build` reads `~` as your home, not the `--home` folder, so it found no key there.
- **When the key is under your home,** the line is its path from `~`, so your home's path isn't written into the config. With no `--home`, or a `--home` that is your home, that's `'~/.kindgi/keys/<id>.pem'`, as before. With `--home ~/work`, it's `'~/work/.kindgi/keys/<id>.pem'`.
- **Otherwise,** the line is the key file's full path. That's a `--home` outside your home, or no `HOME` set. A relative `--home` is resolved from the folder the command ran in.
- The lines are written as `kindgi.config.ts` strings, so a quote or a backslash in a path is escaped.
