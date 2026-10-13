---
"@kindgi/bounds": patch
---

Template renders on a self-hosted server and under `kindgi dev` now have a memory limit: `SELF_HOSTED_BOUNDS.liquid.memoryLimit` is 16,777,216, where it had none. A render past it fails, saying so.
