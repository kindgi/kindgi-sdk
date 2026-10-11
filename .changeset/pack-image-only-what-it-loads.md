---
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
"@kindgi/sdk": patch
---

A TypeScript pack's image can carry only what the pack loads: `image: { dependencies: 'loaded' }` in `kindgi.config` keeps the packages the pack's bundles import by name, with their own dependencies, and what `image.keep` names, instead of every production dependency of the app (`'all'`, still the default).

- Each package is resolved as Node resolves it, over the layout the package manager made (pnpm's links, npm's and Yarn's hoisting), and kept whole.
- A miss fails the build, never a run. An import that isn't installed fails the image's closure step, by name. Every package the bundles import is loaded on the trimmed install before indexing, which runs there too. A `require(x)` / `import(x)` with a computed name in the pack's own code fails `kindgi build`, by file and line, until `image.keep` names what it loads.
- The build prints what it kept of what's installed, and which of the pack's own dependencies its tools don't import.
- A package loaded at run time by a name no gate could see answers with what to add to `image.keep`.
- `prisma()` keeps Prisma 6's generated `.prisma/client` when it's there.
- A Python pack's `[tool.kindgi.image] dependencies = "loaded"` (or `keep`) is refused for now: its image keeps every dependency in the lockfile.
