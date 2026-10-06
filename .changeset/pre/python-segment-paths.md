---
"@kindgi/api": patch
---

The Python client takes a segment path as `{key, value}` steps, as the TypeScript client and `runs.start` do: `agents.live.resolve(…, segments=[{"key": "company", "value": "acme"}])`, and `segments=` on `agents.promotions.list`, the gate-policy resolve and the gate-policy list (each step a `ScopeSegment` or a mapping). It took `segment=["company:acme"]` strings. The OpenAPI document marks the repeated `segment` query parameter with `x-kindgi-segment-path: true`, which the Python generator honours.
