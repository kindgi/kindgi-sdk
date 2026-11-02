---
"@kindgi/api": patch
---

**The store of a test-set version's frozen cases takes its names.** This is a breaking rename, and no old name is kept. `createApp`'s `evalCaseStore` is `frozenCaseStore`, and the types `EvalCaseStoreBinding`, `EvalCasePutInput`, `EvalCaseListInput` and `EvalCasePage` are `FrozenCaseStoreBinding`, `FrozenCasePutInput`, `FrozenCaseListInput` and `FrozenCasePage`. The routes and what they answer are unchanged.
