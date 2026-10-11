---
'@kindgi/cli': patch
---

`kindgi doctor`'s project check names the config file it found (`kindgi.config.mts` in a CommonJS app, not always `kindgi.config.ts`), calls a `.mjs`/`.js`/`.cjs` config's project JavaScript, and, outside a project, lists every config name it looked for.
