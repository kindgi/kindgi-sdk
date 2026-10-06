---
"@kindgi/client": patch
---

A list page carries its list once: `items`, the deprecated name for `data`, is still readable (`page.items`, until 0.2) but is no longer an own enumerable property, so `JSON.stringify(page)`, a spread, and the CLI's JSON output show `data` alone. Before, every list page printed its list twice.
