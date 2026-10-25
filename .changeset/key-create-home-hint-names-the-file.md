---
"@kindgi/cli": patch
---

**`kindgi key create <id> --env <name> --home <dir>`'s note names the key file it wrote.** Before, the `signingKey` line to add was always `'~/.kindgi/keys/<id>.pem'`. `kindgi build` reads `~` as your home, not the `--home` folder, so it found no key there.
- **When the key is under your home,** the line is `'~/.kindgi/keys/<id>.pem'`, as before. That's with no `--home`, or a `--home` that is your home.
- **Otherwise,** the line is the key file's full path. That's a `--home` that isn't your home, a relative one (resolved from the folder the command ran in), or no `HOME` set.
- The lines are written as `kindgi.config.ts` strings, so a quote or a backslash in a path is escaped.
