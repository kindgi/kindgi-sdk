---
"@kindgi/cli": patch
---

**`kindgi init <pack-name>` pins the pnpm that installs the pack.** A new TypeScript pack that stands alone, with no `packageManager` field or lockfile in the folders above it, gets `"packageManager": "pnpm@<version>"` with the version `pnpm --version` gives in its folder. `kindgi build`'s image, CI and teammates then install with that same pnpm; pnpm 10+ switches to it on its own. A pnpm 12 image refuses a lockfile an older pnpm wrote when it has entries less than a day old, so a mismatch can break a build right after a release.

Inside an existing project, nothing is written: that project's own setup governs. Adding Kindgi to an app and Python packs are unchanged. When pnpm's version can't be read, the next steps say so and how to set the field.
