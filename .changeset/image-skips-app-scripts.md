---
"@kindgi/cli": patch
---

A pack image never runs the app's own install scripts.

- **The bug:** `kindgi build` installs the app's dependencies with scripts off, then rebuilds so the dependencies the app allows can build. The rebuild also ran the app's own pending scripts: pnpm and npm treat the project itself as pending. So a `postinstall: prisma generate` or a `prepare: husky` ran in the image and failed the build, since the image holds no schema and no `.git`.
- **The fix:** the build context's copies of the app's project manifests (the root's, each workspace member's, the pack's) leave out their install lifecycle scripts: `preinstall`, `install`, `postinstall`, `prepare` and its pre/post, `prepublish`, `dependencies`. Every other field and script stays. The lockfile, the dependencies' own scripts and the allowlist are untouched. What the image needs from such a script comes from a build extension: `prisma()` runs `prisma generate`.
- **`kindgi build` says what it left out:** "The app's own install scripts don't run in the image: postinstall (`prisma generate`), prepare (`husky`)".
- **A skipped script that runs `patch-package` gets a warning:** its patches wouldn't be applied in the image. To apply them, add a build step: `defineBuildExtension({ name: 'patch-package', contextFiles: [<the patch files>], postInstall: [{ bin: 'patch-package' }] })`. Or, with pnpm, use `pnpm patch`, which the install applies itself.
