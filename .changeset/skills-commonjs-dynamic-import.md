---
"@kindgi/sdk": patch
---

**The tool-authoring skill covers a dynamic import of a package that ships only CommonJS.** `(await import('…')).default` is the class under Vitest and the package's whole `module.exports` under Node, as with a default import, so the skill takes it with the same helper.
