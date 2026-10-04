---
"@kindgi/sdk": patch
---

The tool-authoring skill says what a pack's image needs from the app's own install scripts, which don't run there: `prisma()` from `@kindgi/sdk/build` for a tool that uses Prisma's client, `defineBuildExtension` for other generate steps, and `image.systemPackages` / `image.buildEnv`.
