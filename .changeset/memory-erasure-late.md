---
"@kindgi/memory": patch
"@kindgi/api": patch
---

Memory erasure (T273 M-5): nothing of a person's lands, or is copied, while their erasure runs. Writing a fact for a person (by scope or subject) or a conversation an erasure holds is refused with `409 erasure-in-progress` (`MemoryError` gains `ErasureInProgressError`), from `POST /v1/memory/facts` and from an agent's `kindgi_remember`. `run-erased` is a `410`: judging a run whose content an erasure cleared is refused with it (it answered `409 run-not-finished` before), as is, by the runtime, a replay of a run an erasure cleared or is clearing; a comparison eval run counts such a case as `erased`.
