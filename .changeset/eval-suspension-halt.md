---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**An eval run or an improvement pass stops when its project or tenant does.** The eval subject's new optional `halt` outcome says a case couldn't start because its project is suspended, or its tenant is suspended or closing. The eval run stops at that case, counting it nowhere, and ends `cancelled`, with the reason in its new optional `cancelReason` (`project-suspended`, `tenant-suspended`, `tenant-closing`) and the cases before it in `result`. An improvement pass whose comparison ends that way ends `cancelled` with the same `cancelReason`, and writes no proposal. A runtime that doesn't set `halt` behaves as before: such a case is its own error. Where the runtime suspends projects, starting an eval run in a suspended one, or a pass for one of its agents, is refused `409 project-suspended`. An eval run's webhook event carries `cancelReason` too (`parseEvent`). `kindgi proposals passes list` shows a cancelled pass's `cancelReason` in its outcome column.
