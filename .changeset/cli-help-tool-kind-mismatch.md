---
"@kindgi/cli": patch
---

**`kindgi tools publish`, `kindgi tools reinstate` and `kindgi deploy` name `tool-kind-mismatch` in their help.** A tool id is an MCP endpoint's tool or a tool published here, never both: a publish, a reinstate or a deploy of the other kind is refused, and nothing is written.
