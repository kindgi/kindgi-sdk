---
'@kindgi/cli': patch
---

`kindgi init` adds zod at the version Kindgi is tested with (4.6.5), written exactly when the app pins every dependency exactly or its package manager saves exact versions (`save-exact` / an empty `save-prefix` in `.npmrc`, pnpm's `saveExact`, Yarn's empty `defaultSemverRangePrefix`, Bun's `[install] exact`), and as `^4.6.5` otherwise. The fresh templates take `^4.6.5` too.
