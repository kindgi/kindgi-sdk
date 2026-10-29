---
"@kindgi/runtime": patch
---

**`StepRetryScheduledPayload` declares `left?: true`.** A `step.retry-scheduled` journal entry marked `left: true` (with `nextDelayMs: 0`) is a step left for the run's next resume, because a read it needs failed, rather than a retry by its edge's `retry` policy. Written from runtime 0.3.0; earlier runtimes never set it. The field is optional and absent on an ordinary retry, so existing readers are unaffected. Derived state counts both alike (`nodeAttempts`).
