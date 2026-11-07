---
"@kindgi/api": patch
---

A deployment that fails after its first write now tells the catalog caches about each tool version and guardrail its rollback undid, through `onToolWrite` and `onGuardrailWrite`, as a deployment that lands tells them what it wrote. Before, a runtime whose tool or guardrail cache read the deployment's write before the rollback kept serving it, such as a refreshed code pointer, until the next write or a restart. An unregistered tool version or guardrail is told as `unregister`. A code pointer, config schema or check points put back are told as the deployment tells a refresh: `publish` for a tool version and `register` for a guardrail. A failing hook doesn't change the deployment's answer or stop the other notices.
