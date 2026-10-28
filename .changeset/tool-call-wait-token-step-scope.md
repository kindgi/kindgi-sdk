---
"@kindgi/agents": patch
---

**A gated tool call that a later loop iteration makes again asks again.** A model's call id is unique only within one answer, so two iterations of an agent's loop can send the same id with the same arguments. The wait for a reviewer's answer now carries the step's scope, so the later call waits for an answer of its own instead of finding the earlier one's. A replay of a call still lands on its own wait, and a wait opened before this change keeps the wait it was opened with when the run resumes.
