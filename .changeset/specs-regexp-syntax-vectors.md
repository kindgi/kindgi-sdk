---
"@kindgi/specs": patch
---

**Test vectors for JavaScript's regular-expression syntax.** `test-vectors/regexp-syntax/` holds regular-expression sources with what Node 22's `new RegExp` says to each, with the `u` flag and without: `null` when it takes the source, or the reason it refuses it. An SDK that checks a pattern's syntax where a schema is declared replays them, as the Python and Java SDKs do. `test-vectors/strict-schemas/` gains schemas whose patterns the runtime's strict compile refuses, and the order it finds them in.
