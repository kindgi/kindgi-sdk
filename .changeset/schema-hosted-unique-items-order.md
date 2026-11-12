---
"@kindgi/schema": patch
---

**On the hosted bounds, strict mode names a schema's first problem as it does self-hosted.** On RE2, `uniqueItems` checks an array with code that runs in linear time. It was removed from Ajv and added again, so Ajv walked it after every other keyword: a schema with `uniqueItems` and `properties` and no `type` was refused for `properties` on the hosted bounds and for `uniqueItems` self-hosted, and an array's `uniqueItems` error came after those of `unevaluatedItems`. The keyword now keeps the place Ajv's own has, and a test replays the strict-schemas test vectors on both bounds.
