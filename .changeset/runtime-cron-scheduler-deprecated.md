---
"@kindgi/runtime": patch
---

`SchedulerBinding.startCronScheduler`, `CronSchedulerOptions` and `CronSchedulerHandle` are deprecated. A deployment fires its schedules itself, and nothing calls `startCronScheduler`. To schedule runs, register a `cron` trigger with `TriggerRegistryBinding.register`, which the schedules routes use. They are removed in the next minor release.
