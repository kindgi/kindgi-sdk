---
"@kindgi/sdk": patch
---

**The getting-started and tool-authoring skills cover a tool that needs code from a Next.js module with `import 'server-only'`.** Outside Next.js that line stops the module from loading, so `kindgi test`, `kindgi dev` and `kindgi build` fail on such a tool. The skills tell a coding agent to keep the line, move the code the tool needs into a module without it, have the guarded module re-export that module so the app's own imports don't change, and import the new module from the tool.
