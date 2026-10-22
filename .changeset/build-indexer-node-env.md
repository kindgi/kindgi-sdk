---
"@kindgi/cli": patch
---

**A pack image's indexer loads the pack's modules with `NODE_ENV=production`, as the deployed service does.** Only the final stage set it, so code that picks a development-only path when `NODE_ENV` isn't `production` (a logger's pretty-print transport, say) took that path while `kindgi build` indexed the pack, and the build failed with `file-import-failed`. The indexer stage now sets `NODE_ENV=production`, unless `image.buildEnv` sets `NODE_ENV`, which still wins. The install doesn't get it, so build steps still have their dev dependencies.
