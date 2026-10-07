---
"@kindgi/cli": patch
---

`kindgi init` decides esbuild's install script for npm too: a new TypeScript pack's `package.json` has `"allowScripts": { "esbuild": false }`, and `init` in an existing npm app adds it, as it adds `allowBuilds.esbuild: false` for pnpm. npm 11 no longer warns on the first install that esbuild's script is "not yet covered by allowScripts". esbuild works without its script; npm 10 and pnpm ignore the field. An app's own decision for esbuild is kept.
