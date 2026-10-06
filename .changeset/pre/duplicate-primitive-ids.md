---
"@kindgi/handler-runtime": patch
---

Two files in a pack that define a tool, guardrail, agent or flow with the same id are an error. The indexer kept both, and the pack service silently served only the last. Now the indexer keeps the first file in path order and reports the second: `tools/b.ts: duplicate tool id 'acme.echo' (also defined in tools/a.ts)` (`manifest-validation-failed`), as the Python indexer already does. That holds for two versions of one id as well: a pack serves one version of each primitive. `kindgi build` and `kindgi deploy` refuse the pack; `kindgi dev` prints the error and loads the rest. The same id on two different kinds (a tool and a flow) is still allowed.
