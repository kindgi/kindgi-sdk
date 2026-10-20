---
"@kindgi/cli": patch
---

A TypeScript pack in a pnpm workspace prunes its image to production dependencies without pnpm's question. That prune is a second, filtered install, and pnpm asks before it removes the modules folders for it, which a build has no terminal to answer: pnpm 10 and 11 stopped the build there, and pnpm 9 skipped the prune and left the dev dependencies in the image. The prune passes `--config.confirm-modules-purge=false`; the build scripts' output survives it.
