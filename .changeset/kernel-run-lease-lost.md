---
"@kindgi/runtime": minor
"@kindgi/api": patch
---

`KernelError` gains `RunLeaseLostError` (`code: 'run-lease-lost'`): the executor no longer holds the run's lease, because another executor claimed the run after this one's lease expired. It stops without failing or finishing the run, and the lease holder decides what happens to it. `@kindgi/api` maps it to 409, like `run-already-terminal`.
