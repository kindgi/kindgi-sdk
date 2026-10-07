---
"@kindgi/runtime": patch
---

A run's principal is stored with it. `StartRunParams` takes `principal` (who starts a pending run), and the runtime keeps `RunFlowInput.principal` with the run, so every resume acts for whoever started it: an approval, a timeout, a child waking its flow, or a run recovered after a crash. `ResumeRunInput.principal` absent now means "the stored one". Schedules and other runs with no live caller name the principal they run as here.
