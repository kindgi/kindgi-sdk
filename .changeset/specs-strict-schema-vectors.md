---
"@kindgi/specs": patch
---

**Test vectors for the runtime's strict compile of a pack's JSON Schemas.** `test-vectors/strict-schemas/` holds JSON Schemas a pack may declare, with what the runtime's strict compile says to each: `null` when it compiles the schema, or the reason it refuses it. An SDK that checks a schema where it's declared replays them, as the Python and Java SDKs do.
