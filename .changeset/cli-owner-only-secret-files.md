---
"@kindgi/cli": patch
---

**`kindgi auth login` writes `~/.kindgi/config.json` `0600`, in a `~/.kindgi` that's `0700`.** Before, both took the default mode, so with the usual umask another account on the same computer could read the API key.
- **A file or folder an older CLI wrote is fixed too,** the next time `kindgi auth login` runs. The new key goes into a new `0600` file that replaces the old one, so a program that already had the old file open can't read the new key through it. To fix yours now, run `kindgi auth login` again, or `chmod 600 ~/.kindgi/config.json && chmod 700 ~/.kindgi`.
- **`kindgi key create` sets a `~/.kindgi/keys` folder that's looser than `0700` to `0700`.** Private keys were already `0600`.
- **A new `.env.<name>` file that `kindgi env set` or `kindgi env pull` makes is `0600`.** A file that's already there keeps its mode.
- **`kindgi feedback`'s draft in the temp folder is `0600`.**
- **On Windows, nothing changes.**
