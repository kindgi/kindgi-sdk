---
"@kindgi/api": patch
---

**A list's `include` takes one or more extras: `include=output,waitingFor`.**

- In the spec, `include` on the runs list, an agent's test cases, the cost records (list and get) and the people list is an array of its known values, sent as one comma-separated key (`style: form`, `explode: false`). One value is the same request as before. A client regenerated from `openapi.json` gets a list type there; one generated from an earlier spec keeps working, since one value is still read.
- The server reads the comma form and repeated keys on all five, and skips empty items, so `include=` adds nothing. An unknown value is still `400 bad-input`, now worded alike on all five: ``Unknown `include` value(s): x. Expected one or more of: a, b``. It starts as the runs and people lists' did.
