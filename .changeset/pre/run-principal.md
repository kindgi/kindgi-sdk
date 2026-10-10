---
"@kindgi/runtime": patch
---

A run's principal is stored with it. `StartRunParams` takes `principal` (who starts a pending run), and the runtime keeps `RunFlowInput.principal` with the run, so every resume acts for whoever started it: an approval, a timeout, a child waking its flow, or a run recovered after a crash. Only the start stores it: `ResumeRunInput` no longer takes a `principal`, so a resume can't change whom a run acts for, and a pending run started without one keeps none, whoever adopts it. Schedules and other runs with no live caller name the principal they run as when they start.
