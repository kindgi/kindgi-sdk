---
"@kindgi/cli": patch
---

**`kindgi key create <id> --env <name>` reads the `kindgi.config.ts` in the folder it runs in, and its note follows what that environment has.** Before, it always said to add `signingKey` and `signerKeyId` to the environment, even when they were there.
- **When the environment already names this key,** the note says so, and that `kindgi build --env=<name>` will sign with it. There are no lines to add. That's when its `signingKey` is this key's file, and its `signerKeyId` is this key's id or unset.
- **When it names another key,** the note shows the `signingKey` and `signerKeyId` it has now, then the lines to add, as before.
- **When there's no config, it won't load, or the environment has neither field,** the note is the same as before. The key is made either way.
