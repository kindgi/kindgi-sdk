---
"@kindgi/flow": patch
---

**`loadFlow` checks a sub-flow step's `inputMapping` as it checks a step's.** A `nodeOutputs.<id>` path must name a node of the flow, a node can't map its own output, and the loop-only roots (`iterationIndex`, `iterationOutput`) are refused. Each is `invalid-mapping`, naming the node and the key. Before, such a mapping loaded, and its path resolved to nothing when the child run started. Flow versions already registered aren't checked again.
