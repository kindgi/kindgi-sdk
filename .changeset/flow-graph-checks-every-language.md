---
"@kindgi/flow": patch
"@kindgi/cli": patch
"@kindgi/api": patch
"@kindgi/pack-conformance": patch
---

A Python, Java or Scala pack's flow is now checked as a TypeScript one is. Their indexers check a flow against `flow.schema.json` only, so a flow with a cycle, an edge to or from a step that doesn't exist, no edge from `$start`, or a node id used twice indexed and deployed cleanly, then hung until "Run stuck", completed with nothing run, or skipped a step.

- `@kindgi/flow` exports `flowGraphProblem(flow)`, with its answer type `FlowGraphCheck`: `loadFlow`'s graph checks, run after the schema with every object left open, so a field from a newer SDK is passed over. It answers `ok`, `err` (the error `loadFlow` gives) or `not-judged` (a shape this version doesn't know). `loadFlow` is unchanged.
- `kindgi dev` and `kindgi build` run it on every indexer's result. A flow that fails is a `manifest-validation-failed` file error (`<module>: flow '<id>' is invalid: <code>: <message>`) and is left out of the index file, so `kindgi dev` never serves it, and `kindgi build` stops. A flow whose shape the CLI doesn't know stays, with a `flow-not-checked` warning.
- `POST /v1/deployments` refuses a flow that fails them with `deployment-validation-failed`, and the flow's issue message starts with the check's code (`cycle-detected: …`). A flow already deployed keeps running as before; deploying it again is refused until it's fixed. A field or a shape the API doesn't know is passed over, not refused.
- `@kindgi/pack-conformance` ships an invalid-flow pack per language (`fixtures/<name>-invalid-flow-pack`, whose one flow is `FIXTURE_CYCLE_FLOW_ID`), and a case that its cycle is refused, by the indexer or by `flowGraphProblem` on the index it wrote. A target feeds it through the optional `indexInvalidFlowPack`; a target without it has the case skipped, and the skip says so. Every flow in the fixture pack's index must pass `flowGraphProblem` too. The suite depends on `@kindgi/flow`.

To upgrade a Python, Java or Scala pack: run `kindgi build` (or `kindgi dev`) once on this CLI before you deploy, so a flow the deploy would refuse shows up as a file error first.
