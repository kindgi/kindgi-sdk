---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

A comparison's live baseline names its segments as a path, the way live versions resolve them: `baseline: { live: { projectId, segments: [{ key, value }, …] } }`, coarse to fine. It was an unordered object (`{ tier: 'gold' }`), so a path's order was lost. `segments` follows the rules of a run's and a pin's segment path (lowercase keys, each key once, at most 8), needs `projectId`, and anything else is `400 bad-input`. The CLI's `eval-runs start --baseline-segment` takes `<key>:<value>` (it took `<key>=<value>`), once per step in order, and needs `--baseline-project`. A live baseline is still refused when the run starts (only `recorded` runs today).
