---
"@kindgi/cli": patch
---

**`kindgi dev` warns about an import `kindgi build` would refuse:** a package the pack imports that `package.json` lists only in `devDependencies`. It loads on your machine, but a deployed pack installs production dependencies only, so it's missing there. The warning names the package and the files importing it, at startup and when a save adds one, once per package; after you move it to `dependencies`, the next reload says it's resolved. It checks what a pack image would load from `node_modules`, including what `kindgi.config.ts` imports. `--json` and `--raw` list them as `devOnlyImports`. Python packs aren't checked.
