---
"@kindgi/api": patch
---

A redeploy of the same pack from a new image now refreshes what the deploy derived for what it keeps:
- **A tool already published at that version** gets the new image's code pointer (`codeArtifactRef`).
- **A guardrail the deploy keeps** gets the new pointer and its check's `configSchema`.

If the deploy is refused or fails later, the old values are restored, unless another deploy has refreshed them since (a compare-and-set through the methods' optional `expected`). Registries opt in through two new optional binding methods, `ToolRegistryBinding.refreshCodeArtifactRef` and `GuardrailRegistryBinding.refreshDeployedFields`. A registry without them keeps the first deploy's values, as before. The pointer itself is metadata: pack code runs by tool id and version, or by check name.
