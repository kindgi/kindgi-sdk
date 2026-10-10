---
"@kindgi/sdk": patch
---

The tools skills cover what a coding agent got wrong without them. `kindgi-authoring-tools` 0.4.5 shows a mutating tool's `writes` effect beside `mutating: true` (and the effect kinds), how to log from the handler (`ctx.log`, ids and amounts, never what a person typed), that a tool's tests go beside it, since discovery skips `*.test.*` and `*.spec.*` files and `kindgi test` runs them, and that code the tools share goes outside `tools/` (in `lib/`, say), since discovery loads every file under it. `kindgi-python-authoring-tools` 0.1.3 adds `ctx.log`, with the same rule.
