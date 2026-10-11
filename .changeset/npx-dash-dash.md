---
'@kindgi/cli': patch
---

The commands the CLI prints and runs for an npm project are `npx --no -- kindgi …` (and `npx --no -- prisma …` in an image's build steps): the `--` ends npx's own options, so a `--help` after the command reaches it rather than npm.
