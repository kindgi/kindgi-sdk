---
"@kindgi/cli": patch
---

**A pnpm workspace pack's image no longer carries its dev dependencies' folders after the build steps.** A pack with build steps (`prisma generate`) installs its dev dependencies too, then prunes them once the steps are done.
- **Before:** in a pnpm workspace, the prune unlinked the dev packages from the pack's project, but left their folders in `node_modules/.pnpm`. That's pnpm's cache for an install that might want them back, kept for a week by default. The pack couldn't load them, but the image carried them (TypeScript, a test runner, esbuild, the CLI).
- **Now:** the prune drops them as it goes (`--config.modules-cache-max-age=0`), on pnpm 9 to 12.
- **Unchanged:**
  - what the build steps and the build scripts wrote stays;
  - a pack without build steps installs production dependencies only, as before;
  - a pack outside a workspace prunes with `pnpm prune --prod`, which already drops them on pnpm 10 to 12;
  - npm, yarn and `image.dependencies: 'loaded'` are unchanged.
