---
"@kindgi/runtime": patch
---

**`StepRetryScheduledPayload` declares `childRunId?: RunId`.** A `step.retry-scheduled` journal entry marked `left: true` names, in `childRunId`, the step's agent turn, when the step was left before that turn ended. If the turn has failed or been cancelled by the run's next resume, the step fails, naming the turn, and no new turn starts, so the turn's tools aren't called again. A step left before its turn started has none, nor does a retry by its edge's `retry` policy. Runtimes up to 0.4.0 never set it. The field is optional, so existing readers are unaffected.
