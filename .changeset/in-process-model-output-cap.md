---
"@kindgi/adapter-model-in-process": patch
---

**The in-process model adapter keeps to a model's registered `maxOutputTokens`.** A call that sets no `maxOutputTokens` now gets the one its model is registered with, as the other model adapters do, and `512` only when neither sets one. Before, it got `512` whatever the registration said.
