---
"@kindgi/cli": patch
---

`kindgi doctor` warns when a provider registered from a preset sends agents that name no model somewhere the preset no longer would: to a model the preset no longer lists (re-register for its current models), or, for a registration with no default model, not to the preset's default (re-register, or name a model on your agents). A warning is the new `status: "warn"`: it never fails, so `ok` stays `true` and the exit code `0`. Text output marks it `!`.
