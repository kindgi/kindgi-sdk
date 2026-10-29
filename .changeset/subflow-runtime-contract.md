---
"@kindgi/runtime": patch
---

**What a runtime needs to run a sub-flow step's child flow on its own steps.**
- `subgraph.failed` declares a new reason, `subgraph-unbound`: the child flow's own tools or agents can't be bound, so the child never started. Its `message` names the nodes. Written from runtime 0.3.0; earlier runtimes never write it.
- `RunFlowInput` and `ResumeRunInput` take an optional `childAccess` (`ChildFlowAccess`): the action and resource a sub-flow step checks before it starts its child. Absent, it's `execute` on the child flow, as today.
- `ResumeRunInput` takes an optional, internal `heldBy`: the parent run resuming its child run left for it. Only that parent resumes such a run, at any depth.
