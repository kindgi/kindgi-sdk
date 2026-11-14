---
"@kindgi/specs": patch
---

**Strict-schema test vectors for a name holding a lone surrogate.** `test-vectors/strict-schemas/` gains schemas with such a name under `properties`, `patternProperties`, `dependentSchemas` or `dependencies`. The runtime's strict compile refuses one where it compiles the subschema under the name ("URI malformed"): it writes the name into that subschema's path, URI encoded, and a lone surrogate can't be encoded. It compiles one whose subschema any data passes. The Python and Java SDKs replay them.
