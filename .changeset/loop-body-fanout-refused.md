---
"@kindgi/flow": patch
---

**A fan-out in a loop body is refused when the flow is loaded.** A loop body never ran a fan-out: the run failed at the fan-out, with no branch run. `loadFlow` now refuses such a flow with `LoopBodyFanoutError` (`code: 'loop-body-fanout'`), naming the fan-out (`nodeId`) and the loop whose body holds it (`loopNodeId`), at any nesting level. A subgraph node in a loop body can still run a flow that has a fan-out. The flow schema's `LoopBody` description says so.
