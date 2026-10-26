---
"@kindgi/runtime": patch
"@kindgi/api": patch
---

**A subflow's child run left for its parent's resume.** `KernelError` gains `RunHeldByParentError` (`code: 'run-held-by-parent'`, with `runId` and `parentRunId`): resuming a subflow's child run directly is refused while it's left for its parent's next resume, since only the parent resumes it. `@kindgi/api` maps the code to 409, like `run-lease-lost`. The `subgraph.dispatched`, `.completed`, `.failed` and `.cancelled` journal payloads declare an optional `loopContext`: the loop iteration a subgraph node in a loop body ran in. Written from runtime 0.3.0; earlier runtimes never set it, and existing readers are unaffected. `SubflowDispatchedPayload`'s doc now says when it's written: once the child run has returned, not before it starts.
