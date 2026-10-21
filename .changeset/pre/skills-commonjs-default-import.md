---
"@kindgi/sdk": patch
---

**The tool-authoring skill covers a default import of a package that ships only CommonJS.** A pack's code runs as ES modules, loaded with Node's own `import()`, so Node gives such an import the package's whole `module.exports`, with the class on its `default`, where Vitest, Next.js and tsx in a CommonJS app give the class. A tool, or app code it imports, then passes `kindgi test` and fails under `kindgi dev` with "is not a constructor". The skill tells a coding agent to take the class either way, with a typed helper that compiles under both `NodeNext` and `bundler` module resolution.
