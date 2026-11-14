---
"@kindgi/agents": patch
---

A tool call whose approval a reviewer rejected now says so in the result the model reads: `{ "status": "rejected", "by": "reviewer", "rationale": "…" }`, with `rationale` only when the reviewer gave one. Before, the result was `status` and `rationale` alone, and a model could tell the person that the tool, or the site it acts on, had refused. An answer that isn't a decision still blocks the call as before, with no `by`: no one decided it, and its `rationale` says why it counts as a rejection.
