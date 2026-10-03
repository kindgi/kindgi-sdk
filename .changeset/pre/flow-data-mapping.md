---
"@kindgi/flow": minor
"@kindgi/specs": minor
"@kindgi/handler-runtime": minor
---

Flows can say what each step receives and what the run returns (flow schema-version 1.8.0), and a conditional branch that rejoins no longer stalls.

- `@kindgi/flow`:
  - New optional `inputMapping` on tool / agent nodes: each key resolves from `runInput`, `state` or `nodeOutputs.<nodeId>` when the node dispatches, so a step can combine the run input and the outputs of any earlier steps. Without it, a node still receives its single upstream node's output.
  - New optional flow-level `output: { mapping, schema? }` declaring the run's output.
  - `maxParallelism` is now accepted by the schema; it was in the TypeScript type only, so `loadFlow` rejected it.
  - `resolveMapping(mapping, env)` resolves a `Mapping`; a path that does not resolve omits its key.
  - The loader rejects mappings that name no node, map a node's own output, or use a loop-only root, with the new `invalid-mapping` error. An output schema that does not compile is the new `invalid-flow-output` error.
  - Scheduler: a node whose every incoming edge is not taken, or comes from such a skipped node, is skipped. A join after an `if` branch used to wait for the skipped arm forever, so the run ended as stuck.
- `@kindgi/specs`: `flow.schema.json` 1.8.0 (the `Mapping` and `FlowOutput` definitions; `inputMapping` on leaf nodes; `output` and `maxParallelism` at the root).
- `@kindgi/handler-runtime`: the indexer validates each discovered flow with `loadFlow`, reporting the loader's message as a file error, and keeps `description`, `maxParallelism`, `metadata` and `output` in `index.json`.
