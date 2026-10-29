---
"@kindgi/sdk": patch
---

**The `kindgi-fix-corrections` skill reads exit code 3 as an answer.** `kindgi agents promote --check`, and the request itself, exit 3 when the answer is no or the request waits for an approval. The skill reads the printed outcome, and doesn't take exit 3 for an error.
