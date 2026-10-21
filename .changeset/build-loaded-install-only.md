---
"@kindgi/cli": patch
---

With `image: { dependencies: 'loaded' }`, a TypeScript pack's image downloads only what the pack loads, instead of the app's whole production install trimmed after.

- `kindgi build` cuts the app's `package.json` and lockfile down to the packages the pack loads and their own dependencies, each lockfile entry copied as the app has it (version, resolution, integrity). It checks the result against the app's lockfile, and the image installs it frozen, with the usual command. pnpm (lockfile `9.0`, with its env document, catalogs, overrides and patches), npm (lockfile 2 and 3) and Yarn 1.
- The build says how much of the lockfile the image installs, and which of the pack's own dependencies it leaves out.
- In a few cases, such as Yarn berry, another lockfile version or a local package (`link:`, `file:`, `workspace:`) among what the pack loads, the image keeps the full install, trimmed after, as before. The build line says why.
- A `node_modules` out of date with the lockfile fails the build, naming the package, its folder and the command that brings it back in line (`pnpm install`, `npm ci`, `yarn install`).
