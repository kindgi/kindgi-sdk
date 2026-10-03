---
"@kindgi/runtime": minor
"@kindgi/api": minor
---

A runtime can keep a run's state in memory, and publish journal entries in batches.

- `@kindgi/runtime`:
  - `createRunState()`, `applyJournalEntry(state, entry)` and `cloneRunState(state)`.
    - `deriveRunState(journal)` is the fold of the first two.
    - A runtime reads a run's journal once, then applies each entry it writes, instead of reading the journal again.
    - It dispatches against a clone, so a running step sees the run as it was when the step was dispatched.
  - `KernelEventBusBinding.publishMany?(tenantId, channel, docs)` (optional): publish entries that were written together, in one call. The runtime uses it when the binding has it, and `publish` for each entry otherwise.
- `@kindgi/api`: `EventBusBinding.publishMany?` (optional). It works like `publish` for each doc, with consecutive `seq`s and one notification.
