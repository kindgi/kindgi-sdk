---
"@kindgi/specs": patch
"@kindgi/tools": patch
---

The tool call idempotency key's description now says how its JSON is written: as `JSON.stringify` writes it, no whitespace, and characters beyond ASCII as themselves, never `\u` escapes. In Python that's `json.dumps(parts, separators=(',', ':'), ensure_ascii=False)`; the default `json.dumps` escapes them and gives another key. The key itself is unchanged.
