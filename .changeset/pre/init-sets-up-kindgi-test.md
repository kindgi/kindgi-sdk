---
'@kindgi/cli': patch
'@kindgi/sdk': patch
---

`kindgi init` in an existing app now sets up the tests `kindgi test` runs: `vitest` and `vite` in `devDependencies` (pinned the way the app pins) and a `vitest.config.mts` (`.ts` in a `"type": "module"` app) that runs `kindgi/**/*.test.ts` with the app's tsconfig `paths` as `resolve.alias`. An app that runs vitest already keeps its own setup, and init says what `kindgi test` needs from it. With `--template=sample`, the sample's test comes along. `kindgi test` finds every config name vitest does (`vitest.config.mts` and `.cts` too), and when it finds none, says what an app Kindgi was added to needs. Fresh packs pin vitest 5 and vite 8.
