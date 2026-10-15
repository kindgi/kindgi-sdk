---
"@kindgi/api": patch
"@kindgi/flow": patch
---

**A deployment whose agent or flow carries a schema that doesn't compile is refused, naming where it sits.** `POST /v1/deployments` used to check an index's agents and flows for shape only. An agent's `output.schema`, or a flow's loop, fanout branch or subgraph `outputSchema` or its `output.schema`, that doesn't compile deployed, and then every turn or run refused it. It's now `400 deployment-validation-failed`, as `defineAgent` and the flow loader refuse it: one issue per schema, at its path (`/output/schema`, `/nodes/<i>/branches/<k>/outputSchema`, …). An agent's `output` that isn't an object is refused at `/output`. Each compile counts against the tenant's compile budget, as the deployment's other compiles do.
- `flowSchemaProblems(flow)` (`@kindgi/flow`) lists every inline schema of a flow that doesn't compile, where a run compiles it, with its path: for a flow that never went through `loadFlow`.
