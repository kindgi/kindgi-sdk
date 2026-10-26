---
"@kindgi/api": patch
---

**The release gate's replay checks say "tool calls", not "writes".** `replay.maxRefusedWrites` and a comparison's `refusedWrites` count every tool call the replay refused, and that includes reads: one that needs an approval or reaches outside, with no recording of the same call. The gate said "N writes were refused" and "N cases stopped at a refused write". It now says "N tool calls were refused" and "N cases stopped at a refused tool call", and the API's descriptions say what counts. The fields, the check names and the counts don't change.
