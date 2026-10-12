---
"@kindgi/guardrails": patch
---

**`must-cite` and `output-matches` compile their patterns with `@kindgi/bounds`,** once per config for its registration and every evaluation after it (they compiled on every evaluation, twice).
- A pattern longer than the process's limit is refused like one that doesn't compile: 8,192 characters with its flags, unless the server sets other bounds. A server under the hosted profile runs patterns on RE2 and refuses, by name, what RE2 lacks.
- `must-cite` stops counting once it has found `minCitations`, so a pass reports that many as `citationCount`; a fail still reports every one found.
